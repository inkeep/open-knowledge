/**
 * Cross-process advisory file lock for short-held critical sections.
 *
 * Used to serialize concurrent writers to shared `~/.ok/global.yml` (and
 * `<project>/.ok/config.yml` / `.ok/local/config.yml`) across multiple
 * OpenKnowledge processes — every project window runs its own Hocuspocus
 * server, so two windows toggling Settings simultaneously can otherwise
 * clobber each other on disk.
 *
 * Primitive: `openSync(lockPath, 'wx', 0o600)` (`O_CREAT | O_EXCL`). Same
 * atomic-create pattern as `packages/server/src/process-lock.ts`, but a
 * different use shape — long-held ownership there vs. short-held mutex here.
 *
 * Stale-lock recovery: a lockfile older than `2 * timeoutMs` is
 * force-cleared. Covers a process that crashed mid-critical-section without
 * running its `finally` block. The factor of 2 keeps us conservative: a
 * slow `fn` cannot accidentally trip its own staleness threshold.
 *
 * Not reentrant — calling `withFileLock(samePath, ...)` from within `fn`
 * deadlocks. The current callers (`storeConfigDoc`, `writeConfigPatch`) do
 * not need reentrance; add a process-local refcount if a future caller does.
 */

import { closeSync, openSync, statSync, unlinkSync } from 'node:fs';

export interface WithFileLockOptions {
  /** Total acquire-retry budget. Default 5_000ms. */
  timeoutMs?: number;
  /** Sleep between EEXIST retries. Default 25ms. */
  retryIntervalMs?: number;
  /**
   * Optional callback for diagnostics (e.g. stale-lock clears). Wired by
   * server callers to a structured logger. The helper never logs by itself
   * to keep `core/util` free of logger dependencies.
   */
  onWarn?: (message: string, context: Record<string, unknown>) => void;
}

export class FileLockTimeoutError extends Error {
  readonly code = 'LOCK_TIMEOUT';
  readonly lockPath: string;
  readonly timeoutMs: number;
  constructor(lockPath: string, timeoutMs: number) {
    super(`Could not acquire file lock at ${lockPath} within ${timeoutMs}ms`);
    this.name = 'FileLockTimeoutError';
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Acquire `lockPath`, run `fn`, release. The lockfile is unlinked on
 * release (best-effort — cleanup never throws). On acquire timeout, throws
 * `FileLockTimeoutError` (`code: 'LOCK_TIMEOUT'`); the caller can choose
 * to degrade gracefully or surface the failure.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: WithFileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const retryIntervalMs = opts.retryIntervalMs ?? 25;
  const staleThresholdMs = timeoutMs * 2;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      // Lockfile exists. Check whether it's stale — a holder that crashed
      // before unlinking would otherwise wedge writers indefinitely. The
      // stat-race catch is narrowed to the statSync call so a throwing
      // onWarn callback propagates instead of being silently swallowed
      // (which would mask the cleared=false path that wedges the acquire
      // loop to timeout). The interface contract for onWarn does not
      // prohibit throwing callbacks.
      let ageMs: number | undefined;
      try {
        const st = statSync(lockPath);
        ageMs = Date.now() - st.mtimeMs;
      } catch {
        // stat failed (file unlinked between EEXIST and stat) — retry.
        continue;
      }

      let cleared = false;
      if (ageMs > staleThresholdMs) {
        opts.onWarn?.('cleared stale file lock', {
          lockPath,
          ageMs,
          staleThresholdMs,
        });
        try {
          unlinkSync(lockPath);
          cleared = true;
        } catch {
          // Lost the unlink race with another waiter — retry.
        }
      }

      if (cleared) continue;
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(lockPath, timeoutMs);
      }
      await sleep(retryIntervalMs);
      continue;
    }

    try {
      return await fn();
    } finally {
      try {
        closeSync(fd);
      } catch {
        // fd already closed
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // best-effort cleanup; another acquirer may have force-cleared
      }
    }
  }
}

/**
 * Synchronous busy-wait sleep. Used by `withFileLockSync` retry path when
 * the EEXIST loop has to wait for the holder to release. Burns CPU for
 * `ms` milliseconds — bounded by `WithFileLockOptions.retryIntervalMs`
 * (default 25 ms) per retry, and by `timeoutMs` (default 5_000 ms) per
 * acquire. Acceptable for the rare-contention edge case this sync variant
 * targets (concurrent MCP host-config writes during desktop consent +
 * startup-repair + CLI `ok init`); not appropriate for high-contention
 * workloads. Prefer `withFileLock` (async) whenever the caller can `await`.
 */
function sleepSyncBusy(ms: number): void {
  const target = Date.now() + ms;
  while (Date.now() < target) {
    // intentional spin
  }
}

/**
 * Synchronous sibling to `withFileLock`. Same atomicity contract and
 * stale-lock recovery, but blocks the event loop during the retry sleep
 * (busy-wait, see `sleepSyncBusy`). Use ONLY when the caller cannot
 * `await` — e.g. inside a sync exported function whose call graph isn't
 * worth flipping async just to add the lock.
 *
 * Tradeoff vs. `withFileLock`: the busy-wait can burn up to `timeoutMs`
 * worth of CPU under sustained contention. Typical MCP host-config
 * writes hold the lock for ~5 ms each; with N concurrent writers, the
 * Nth waiter spins for at most N * 5 ms before acquiring. The 5 s
 * timeout is the worst-case bound.
 */
export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  opts: WithFileLockOptions = {},
): T {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const retryIntervalMs = opts.retryIntervalMs ?? 25;
  const staleThresholdMs = timeoutMs * 2;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      // Lockfile exists. Same shape as the async variant: stat-race
      // catch is narrowed to statSync so a throwing onWarn callback
      // propagates instead of being silently swallowed (which would
      // mask the cleared=false path that wedges the acquire loop to
      // timeout).
      let ageMs: number | undefined;
      try {
        const st = statSync(lockPath);
        ageMs = Date.now() - st.mtimeMs;
      } catch {
        // stat failed (file unlinked between EEXIST and stat) — retry.
        continue;
      }

      let cleared = false;
      if (ageMs > staleThresholdMs) {
        opts.onWarn?.('cleared stale file lock', {
          lockPath,
          ageMs,
          staleThresholdMs,
        });
        try {
          unlinkSync(lockPath);
          cleared = true;
        } catch {
          // Lost the unlink race with another waiter — retry.
        }
      }

      if (cleared) continue;
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(lockPath, timeoutMs);
      }
      sleepSyncBusy(retryIntervalMs);
      continue;
    }

    try {
      return fn();
    } finally {
      try {
        closeSync(fd);
      } catch {
        // fd already closed
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // best-effort cleanup; another acquirer may have force-cleared
      }
    }
  }
}
