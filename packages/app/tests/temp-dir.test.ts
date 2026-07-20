import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { withTempDir } from './temp-dir.test-helper.ts';

describe('withTempDir', () => {
  test('provides a usable dir, returns fn result, and removes the dir after', async () => {
    let captured = '';
    const result = await withTempDir('temp-dir-test-', async (dir) => {
      captured = dir;
      expect(existsSync(dir)).toBe(true);
      await writeFile(join(dir, 'f.txt'), 'x');
      return 42;
    });
    expect(result).toBe(42);
    expect(captured).not.toBe('');
    expect(existsSync(captured)).toBe(false);
  });

  test('removes the directory even when fn throws', async () => {
    // Cleanup-on-throw is the helper's entire raison d'être: a failing
    // assertion inside the callback must not leak the tmp dir.
    let captured = '';
    await expect(
      withTempDir('temp-dir-test-', (dir) => {
        captured = dir;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(captured).not.toBe('');
    expect(existsSync(captured)).toBe(false);
  });
});
