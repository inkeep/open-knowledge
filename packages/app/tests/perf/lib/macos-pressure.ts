/**
 * macOS `vm_pressure` detection primitive for the cap-graduation sweep
 * harness.
 *
 * The cap-regime ceiling is kernel-pressure-based, not byte-based. The
 * sweep harness reads `kern.memorystatus_vm_pressure_level` via `sysctl`
 * to detect when a cell crosses the platform ceiling — distinct from
 * the V8 heap limit (which is the hard-kill threshold, not the UX
 * ceiling).
 *
 * Why `sysctl` and not `memory_pressure -l`:
 *   `memory_pressure(1)` is an injection tool that synthesizes pressure
 *   on the kernel for testing. It is NOT a monitor. Reading from
 *   `sysctl -n kern.memorystatus_vm_pressure_level` is the canonical
 *   read-side of the same kernel state Activity Monitor renders.
 *
 * Why polling and not kqueue `EVFILT_VM NOTE_PRESSURE`:
 *   kqueue would require a native Node addon (Bun has no native kqueue
 *   binding). At 1 Hz, polling lag is 3-10% of typical 10-30s cell
 *   windows — acceptable for sweep-cell verdict trips, where we only
 *   care that pressure crossed WARN/CRITICAL at some point during the
 *   measurement window, not the exact microsecond.
 *
 * Precedent: `Bun.spawn(...)` for subprocess wrapping mirrors the
 * pattern used in `perf-compare.test.ts` (perf-compare.sh invocation).
 */

const SYSCTL_BIN = '/usr/sbin/sysctl';
const SYSCTL_KEY = 'kern.memorystatus_vm_pressure_level';

/**
 * Kernel-reported macOS memory pressure level.
 *
 * Values mirror the `kern.memorystatus_vm_pressure_level` sysctl:
 *   1 = NORMAL    (no pressure)
 *   2 = WARN      (pressure threshold crossed; system about to evict)
 *   4 = CRITICAL  (pressure severe; jetsam imminent on iOS, swap on macOS)
 *
 * (3 is reserved by the kernel and not emitted in practice; the public
 * surface accepts only 1 | 2 | 4.)
 */
export type PressureLevel = 1 | 2 | 4;

/**
 * One observation of the pressure-level sysctl, with metadata describing
 * how it was obtained.
 *
 * Discriminator semantics:
 *   - `platform: 'macos'`  — call succeeded from sysctl, `level` is kernel-reported.
 *   - `platform: 'non-macos'` — host is not macOS; `level` defaults to 1 (NORMAL)
 *     so callers can compose without branching, but `error.code = 'unsupported-platform'`
 *     so consumers that need to know the signal is unavailable can detect it.
 *   - `platform: 'macos'` + `error` populated — sysctl invocation failed
 *     (binary missing, parse failed, non-zero exit); `level` defaults to 1 and
 *     `error.exitCode` + `error.stderr` capture what went wrong.
 */
export interface PressureSample {
  readonly level: PressureLevel;
  readonly platform: 'macos' | 'non-macos';
  readonly capturedAt: string;
  readonly error?: PressureError;
}

export interface PressureError {
  readonly code: 'unsupported-platform' | 'spawn-failed' | 'non-zero-exit' | 'parse-failed';
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly rawStdout?: string;
}

export interface SamplePressureDuringOptions {
  /** Polling interval in milliseconds. Default: 1000 (1 Hz). */
  readonly intervalMs?: number;
}

export interface SamplePressureResult<T> {
  readonly result: T;
  readonly samples: ReadonlyArray<PressureSample>;
  /**
   * Worst-case (numerically highest) level observed during the measurement
   * window. Returns 1 (NORMAL) when no samples were recorded — e.g. on
   * non-macOS hosts when fn resolves before the first tick.
   */
  readonly maxLevel: PressureLevel;
}

/**
 * Read the current macOS memory-pressure level once.
 *
 * On macOS, shells out to `sysctl -n kern.memorystatus_vm_pressure_level`
 * and returns the parsed integer level (1 | 2 | 4).
 *
 * On non-macOS hosts OR on sysctl failure (binary missing, non-zero exit,
 * unparseable output), silently falls back to 1 (NORMAL). This is the
 * thin-convenience entry point — it discards failure detail intentionally.
 * Callers that need to know whether the read succeeded (e.g. the sweep
 * sampler that surfaces stderr in PressureSample.error) should use
 * `readPressureSample()` instead.
 */
export async function readPressureLevel(): Promise<PressureLevel> {
  const sample = await readPressureSample();
  return sample.level;
}

/**
 * Read the current macOS memory-pressure level once, returning the full
 * PressureSample shape so failure modes are observable.
 *
 * This is the surface the sweep sampler relies on. Failures DO NOT throw —
 * they are encoded in `sample.error` (code + exitCode + stderr) and the
 * `sample.level` field falls back to 1 so a partial signal stays usable.
 * Silently swallowing the failure would mask infrastructure regressions
 * (e.g. sysctl binary missing on a new macOS major); surfacing them via
 * PressureSample lets the sweep cell-verdict consume the partial signal
 * without losing the diagnostic.
 */
export async function readPressureSample(): Promise<PressureSample> {
  const capturedAt = new Date().toISOString();

  if (process.platform !== 'darwin') {
    return {
      level: 1,
      platform: 'non-macos',
      capturedAt,
      error: { code: 'unsupported-platform' },
    };
  }

  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    const proc = Bun.spawn([SYSCTL_BIN, '-n', SYSCTL_KEY], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    exitCode = await proc.exited;
    stdout = (await new Response(proc.stdout).text()).trim();
    stderr = (await new Response(proc.stderr).text()).trim();
  } catch (err) {
    return {
      level: 1,
      platform: 'macos',
      capturedAt,
      error: {
        code: 'spawn-failed',
        stderr: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (exitCode !== 0) {
    return {
      level: 1,
      platform: 'macos',
      capturedAt,
      error: {
        code: 'non-zero-exit',
        exitCode,
        stderr,
        rawStdout: stdout,
      },
    };
  }

  const parsed = Number.parseInt(stdout, 10);
  if (!isPressureLevel(parsed)) {
    return {
      level: 1,
      platform: 'macos',
      capturedAt,
      error: {
        code: 'parse-failed',
        rawStdout: stdout,
      },
    };
  }

  return {
    level: parsed,
    platform: 'macos',
    capturedAt,
  };
}

/**
 * Wrap a long-running operation with periodic vm_pressure sampling. Returns
 * the operation's result plus every sample taken during the run plus the
 * worst-case level observed — the field the sweep cell-verdict reads to
 * decide whether the cell hit the memory ceiling.
 *
 * Sampling cadence defaults to 1 Hz. The first sample is taken
 * immediately on entry so a sub-second `fn` still yields one observation.
 * The last sample is taken on exit regardless of timer fire, so the worst
 * moment of pressure isn't lost to a missed tick.
 *
 * Errors from individual samples (sysctl missing, parse failure, etc.) do
 * NOT abort the operation — they are preserved in the corresponding
 * `PressureSample.error` and the level falls back to 1 for that sample.
 * This matches the sweep harness's per-cell error semantics: instrumentation
 * failures degrade gracefully so a partial signal is still usable.
 */
export async function samplePressureDuring<T>(
  options: SamplePressureDuringOptions,
  fn: () => Promise<T>,
): Promise<SamplePressureResult<T>> {
  const intervalMs = options.intervalMs ?? 1000;
  const samples: PressureSample[] = [];

  samples.push(await readPressureSample());

  let sampling = true;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  // Self-rescheduling tick chain (NOT setInterval). setInterval fires
  // every intervalMs regardless of whether the prior tick completed;
  // under load — precisely when pressure sampling matters — a sysctl
  // shell-out can exceed the 1s interval, accumulating concurrent
  // subprocesses. The recursive setTimeout pattern schedules the next
  // tick only after the current sample completes (or its timeout fires),
  // bounding concurrent subprocess count to 1 deterministically.
  const tick = async (): Promise<void> => {
    if (!sampling) return;
    // 2s upper bound on each sysctl call. sysctl is normally <5ms, but a
    // hung subprocess would otherwise hang the cell indefinitely (the
    // sweep cell's mount-stalled timeout wraps `runCell` but not the
    // post-workload samplePressureDuring call). The race-with-timeout
    // surfaces a 'spawn-failed' sample rather than hanging.
    const sample = await Promise.race<PressureSample>([
      readPressureSample(),
      new Promise<PressureSample>((resolve) =>
        setTimeout(() => {
          resolve({
            level: 1,
            capturedAt: new Date().toISOString(),
            platform: process.platform === 'darwin' ? 'macos' : 'non-macos',
            error: {
              code: 'spawn-failed',
              stderr: `readPressureSample exceeded ${SAMPLE_TIMEOUT_MS}ms timeout`,
            },
          });
        }, SAMPLE_TIMEOUT_MS),
      ),
    ]);
    if (sampling) {
      samples.push(sample);
      pendingTimer = setTimeout(() => {
        void tick();
      }, intervalMs);
    }
  };

  pendingTimer = setTimeout(() => {
    void tick();
  }, intervalMs);

  let result: T;
  try {
    result = await fn();
  } finally {
    sampling = false;
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    samples.push(await readPressureSample());
  }

  const maxLevel = samples.reduce<PressureLevel>(
    (acc, sample) => (sample.level > acc ? sample.level : acc),
    1,
  );

  return {
    result,
    samples,
    maxLevel,
  };
}

/** Max time we'll wait for a single sysctl read before declaring it hung. */
const SAMPLE_TIMEOUT_MS = 2000;

/**
 * Type guard for the kernel's PressureLevel enum. Public so test fixtures
 * can exercise the parse path directly without re-deriving the valid-value
 * set.
 */
export function isPressureLevel(value: number): value is PressureLevel {
  return value === 1 || value === 2 || value === 4;
}
