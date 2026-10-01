import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { withFileLock, withFileLockSync } from './file-lock.ts';
import { arrangeExpiredFileLock } from './file-lock-deadline.test-helper.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync) };
});

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ok-file-lock-deadline-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe.each(['sync', 'async'] as const)('%s acquisition deadline', (variant) => {
  test.each(['stable', 'disappearing', 'stale'] as const)(
    'keeps the protected file unchanged when a %s lock exhausts acquisition',
    async (schedule) => {
      const targetPath = join(directory, 'target.json');
      const lockPath = `${targetPath}.lock`;
      const timeoutMs = 5_000;
      writeFileSync(targetPath, 'original');
      await arrangeExpiredFileLock(lockPath, schedule, timeoutMs);

      const write = () => writeFileSync(targetPath, 'unexpected');
      const attempt = Promise.resolve().then(() =>
        variant === 'sync'
          ? withFileLockSync(lockPath, write, { timeoutMs })
          : withFileLock(lockPath, async () => write(), { timeoutMs }),
      );

      await expect(attempt).rejects.toMatchObject({
        name: 'FileLockTimeoutError',
        code: 'LOCK_TIMEOUT',
        lockPath,
        timeoutMs,
      });
      expect(readFileSync(targetPath, 'utf-8')).toBe('original');
    },
  );

  test('permits an immediately available lock without a retry budget', async () => {
    const lockPath = join(directory, 'available.lock');
    const result =
      variant === 'sync'
        ? withFileLockSync(lockPath, () => 'written', { timeoutMs: 0 })
        : await withFileLock(lockPath, async () => 'written', { timeoutMs: 0 });

    expect(result).toBe('written');
  });
});
