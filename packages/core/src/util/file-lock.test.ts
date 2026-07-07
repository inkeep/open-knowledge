import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLockTimeoutError, withFileLock, withFileLockSync } from './file-lock.ts';

let testDir: string;
let lockPath: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ok-file-lock-'));
  lockPath = join(testDir, 'target.lock');
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('withFileLock — sequential', () => {
  test('runs fn, returns its result, removes the lockfile', async () => {
    const result = await withFileLock(lockPath, async () => {
      expect(existsSync(lockPath)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('removes the lockfile when fn throws', async () => {
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('withFileLock — concurrent', () => {
  test('serializes 10 concurrent calls; no overlap', async () => {
    let active = 0;
    let maxActive = 0;
    let totalRuns = 0;

    const tasks = Array.from({ length: 10 }, (_, i) =>
      withFileLock(lockPath, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        totalRuns += 1;
        // Yield to the event loop so any racing call has a chance to overlap
        // if serialization is broken.
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return i;
      }),
    );

    const results = await Promise.all(tasks);
    expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(totalRuns).toBe(10);
    expect(maxActive).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('withFileLock — stale-lock recovery', () => {
  test('force-clears a lockfile whose mtime is older than 2 * timeoutMs', async () => {
    // Pre-create a lockfile from a "crashed" prior holder.
    writeFileSync(lockPath, '', { mode: 0o600 });
    const ancient = new Date('2000-01-01T00:00:00Z');
    utimesSync(lockPath, ancient, ancient);

    const warnings: Array<{ message: string; context: Record<string, unknown> }> = [];
    const result = await withFileLock(lockPath, async () => 'acquired', {
      timeoutMs: 200,
      onWarn: (message, context) => warnings.push({ message, context }),
    });

    expect(result).toBe('acquired');
    expect(existsSync(lockPath)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('cleared stale file lock');
    expect(warnings[0]?.context.lockPath).toBe(lockPath);
  });

  test('onWarn that throws propagates the exception (no silent swallow)', async () => {
    // Pre-create a stale lockfile so the stale-clear path runs.
    writeFileSync(lockPath, '', { mode: 0o600 });
    const ancient = new Date('2000-01-01T00:00:00Z');
    utimesSync(lockPath, ancient, ancient);

    await expect(
      withFileLock(lockPath, async () => 'never', {
        timeoutMs: 200,
        onWarn: () => {
          throw new Error('logger broke');
        },
      }),
    ).rejects.toThrow('logger broke');
  });
});

describe('withFileLock — timeout', () => {
  test('rejects with FileLockTimeoutError when the lock is held past timeoutMs', async () => {
    let release!: () => void;
    const releaseSignal = new Promise<void>((r) => {
      release = r;
    });

    // Start a long-held lock that we'll release manually.
    const heldPromise = withFileLock(lockPath, async () => {
      await releaseSignal;
    });

    // Try to acquire while held — should time out fast.
    await expect(
      withFileLock(lockPath, async () => 'never', {
        timeoutMs: 100,
        retryIntervalMs: 10,
      }),
    ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT', name: 'FileLockTimeoutError' });

    release();
    await heldPromise;
    expect(existsSync(lockPath)).toBe(false);
  });

  test('FileLockTimeoutError carries lockPath and timeoutMs', async () => {
    let release!: () => void;
    const releaseSignal = new Promise<void>((r) => {
      release = r;
    });

    const heldPromise = withFileLock(lockPath, async () => {
      await releaseSignal;
    });

    let captured: unknown;
    try {
      await withFileLock(lockPath, async () => 'unreachable', {
        timeoutMs: 80,
        retryIntervalMs: 10,
      });
    } catch (e) {
      captured = e;
    }

    expect(captured).toBeInstanceOf(FileLockTimeoutError);
    const e = captured as FileLockTimeoutError;
    expect(e.lockPath).toBe(lockPath);
    expect(e.timeoutMs).toBe(80);

    release();
    await heldPromise;
  });
});

// Sync variant — mirrors the async suite's shape (sequential happy path,
// stale-lock recovery, timeout) so a regression in the busy-wait or sync
// stale-clear path can't hide behind the CI-skipped cross-process race
// test that's the only other coverage for `withFileLockSync`.
describe('withFileLockSync — sequential', () => {
  test('runs fn, returns its result, removes the lockfile', () => {
    const result = withFileLockSync(lockPath, () => {
      expect(existsSync(lockPath)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('removes the lockfile when fn throws', () => {
    expect(() =>
      withFileLockSync(lockPath, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('withFileLockSync — stale-lock recovery', () => {
  test('force-clears a lockfile whose mtime is older than 2 * timeoutMs', () => {
    // Pre-create a lockfile from a "crashed" prior holder.
    writeFileSync(lockPath, '', { mode: 0o600 });
    const ancient = new Date('2000-01-01T00:00:00Z');
    utimesSync(lockPath, ancient, ancient);

    const warnings: Array<{ message: string; context: Record<string, unknown> }> = [];
    const result = withFileLockSync(lockPath, () => 'acquired', {
      timeoutMs: 200,
      onWarn: (message, context) => warnings.push({ message, context }),
    });

    expect(result).toBe('acquired');
    expect(existsSync(lockPath)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('cleared stale file lock');
    expect(warnings[0]?.context.lockPath).toBe(lockPath);
  });

  test('onWarn that throws propagates the exception (no silent swallow)', () => {
    // Pre-create a stale lockfile so the stale-clear path runs.
    writeFileSync(lockPath, '', { mode: 0o600 });
    const ancient = new Date('2000-01-01T00:00:00Z');
    utimesSync(lockPath, ancient, ancient);

    expect(() =>
      withFileLockSync(lockPath, () => 'never', {
        timeoutMs: 200,
        onWarn: () => {
          throw new Error('logger broke');
        },
      }),
    ).toThrow('logger broke');
  });
});

describe('withFileLockSync — timeout', () => {
  test('throws FileLockTimeoutError when the lock is held past timeoutMs', () => {
    // Pre-create a fresh lockfile (mtime = now) so the sync busy-wait can't
    // clear it as stale during the short timeout window.
    writeFileSync(lockPath, '', { mode: 0o600 });

    expect(() =>
      withFileLockSync(lockPath, () => 'never', {
        timeoutMs: 100,
        retryIntervalMs: 10,
      }),
    ).toThrow(FileLockTimeoutError);
  });

  test('FileLockTimeoutError carries lockPath and timeoutMs', () => {
    writeFileSync(lockPath, '', { mode: 0o600 });

    let captured: unknown;
    try {
      withFileLockSync(lockPath, () => 'unreachable', {
        timeoutMs: 80,
        retryIntervalMs: 10,
      });
    } catch (e) {
      captured = e;
    }

    expect(captured).toBeInstanceOf(FileLockTimeoutError);
    const e = captured as FileLockTimeoutError;
    expect(e.lockPath).toBe(lockPath);
    expect(e.timeoutMs).toBe(80);
  });
});
