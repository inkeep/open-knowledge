
import { closeSync, openSync, statSync, unlinkSync } from 'node:fs';

export interface WithFileLockOptions {
  timeoutMs?: number;
  retryIntervalMs?: number;
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

      let ageMs: number | undefined;
      try {
        const st = statSync(lockPath);
        ageMs = Date.now() - st.mtimeMs;
      } catch {
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
      }
      try {
        unlinkSync(lockPath);
      } catch {
      }
    }
  }
}

function sleepSyncBusy(ms: number): void {
  const target = Date.now() + ms;
  while (Date.now() < target) {
  }
}

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

      let ageMs: number | undefined;
      try {
        const st = statSync(lockPath);
        ageMs = Date.now() - st.mtimeMs;
      } catch {
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
      }
      try {
        unlinkSync(lockPath);
      } catch {
      }
    }
  }
}
