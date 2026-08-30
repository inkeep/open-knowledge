import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper.ts';

describe('removeTempDirBestEffort', () => {
  test('removes a directory and everything under it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-temp-cleanup-'));
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'file.txt'), 'content');

    removeTempDirBestEffort(dir);

    expect(existsSync(dir)).toBe(false);
  });

  test('no-ops on a path that is already gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-temp-cleanup-gone-'));
    rmSync(dir, { recursive: true });

    expect(() => removeTempDirBestEffort(dir)).not.toThrow();
  });

  // The contract that keeps a teardown from overturning a passing verdict. A
  // read-only parent is the POSIX way to make the removal fail: `chmod` on
  // Windows only toggles a read-only attribute and would not block it, and root
  // is not subject to the permission check at all.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'swallows a removal the OS refuses',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'ok-temp-cleanup-locked-'));
      const child = join(root, 'child');
      mkdirSync(child);
      writeFileSync(join(child, 'file.txt'), 'content');
      chmodSync(root, 0o555);

      try {
        expect(() => removeTempDirBestEffort(child)).not.toThrow();
        expect(existsSync(child), 'the removal succeeded, so no refusal was exercised').toBe(true);
      } finally {
        chmodSync(root, 0o755);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
