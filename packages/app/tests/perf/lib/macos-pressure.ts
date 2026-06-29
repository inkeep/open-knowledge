
const SYSCTL_BIN = '/usr/sbin/sysctl';
const SYSCTL_KEY = 'kern.memorystatus_vm_pressure_level';

export type PressureLevel = 1 | 2 | 4;

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
  readonly intervalMs?: number;
}

export interface SamplePressureResult<T> {
  readonly result: T;
  readonly samples: ReadonlyArray<PressureSample>;
  readonly maxLevel: PressureLevel;
}

export async function readPressureLevel(): Promise<PressureLevel> {
  const sample = await readPressureSample();
  return sample.level;
}

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

export async function samplePressureDuring<T>(
  options: SamplePressureDuringOptions,
  fn: () => Promise<T>,
): Promise<SamplePressureResult<T>> {
  const intervalMs = options.intervalMs ?? 1000;
  const samples: PressureSample[] = [];

  samples.push(await readPressureSample());

  let sampling = true;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (!sampling) return;
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

const SAMPLE_TIMEOUT_MS = 2000;

export function isPressureLevel(value: number): value is PressureLevel {
  return value === 1 || value === 2 || value === 4;
}
