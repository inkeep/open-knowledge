import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runningAsRoot } from './capabilities.test-helper.ts';
import { createTempDirFactory, withTempDir } from './temp-dir.test-helper.ts';

async function withSystemTempDirAt(fn: (root: string) => Promise<void>): Promise<void> {
  await withTempDir('ok-temp-owner-', async (root) => {
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(key, root);
    try {
      await fn(root);
    } finally {
      vi.unstubAllEnvs();
    }
  });
}

test('registered cleanup removes owned trees and preserves neighboring files', async () => {
  await withSystemTempDirAt(async (root) => {
    let cleanup = async () => {};
    const create = createTempDirFactory((registered) => {
      cleanup = registered;
    });
    const neighbor = join(root, 'neighbor.txt');
    writeFileSync(neighbor, 'retained');
    const first = create('first-');
    const second = create('second-');
    mkdirSync(join(first, 'nested'));
    writeFileSync(join(first, 'nested', 'data.txt'), 'fixture');
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    await cleanup();
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(readFileSync(neighbor, 'utf8')).toBe('retained');
    expect([dirname(first), dirname(second)]).toEqual([root, root]);
  });
});

test('registered cleanup can release a later allocation after an earlier cleanup', async () => {
  await withSystemTempDirAt(async () => {
    let cleanup = async () => {};
    const create = createTempDirFactory((registered) => {
      cleanup = registered;
    });
    const first = create('round-');
    await cleanup();
    const second = create('round-');
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    await cleanup();
    expect(existsSync(second)).toBe(false);
  });
});

test('registered cleanup attempts every removal and reports each failure', async (ctx) => {
  ctx.skip(runningAsRoot, 'root bypasses the chmod refusal this test induces');
  await withSystemTempDirAt(async (root) => {
    let cleanup = async () => {};
    const create = createTempDirFactory((registered) => {
      cleanup = registered;
    });
    const allocateUnder = (parentName: string, prefix: string) => {
      const parent = join(root, parentName);
      mkdirSync(parent);
      for (const key of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(key, parent);
      return { parent, path: create(prefix) };
    };
    const first = allocateUnder('locked-first', 'first-');
    const second = allocateUnder('locked-second', 'second-');
    const removable = allocateUnder('writable', 'removable-');
    expect(existsSync(removable.path)).toBe(true);
    let failure: unknown;
    try {
      chmodSync(first.parent, 0o500);
      chmodSync(second.parent, 0o500);
      failure = await cleanup().then(
        () => undefined,
        (error: unknown) => error,
      );
    } finally {
      chmodSync(first.parent, 0o700);
      chmodSync(second.parent, 0o700);
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EACCES', path: first.path }),
        expect.objectContaining({ code: 'EACCES', path: second.path }),
      ]),
    );
    expect(existsSync(removable.path)).toBe(false);
  });
});

test('registered cleanup rejects with the original error when one removal fails', async (ctx) => {
  ctx.skip(runningAsRoot, 'root bypasses the chmod refusal this test induces');
  await withSystemTempDirAt(async (root) => {
    let cleanup = async () => {};
    const create = createTempDirFactory((registered) => {
      cleanup = registered;
    });
    const locked = create('locked-');
    chmodSync(root, 0o500);
    const failure = await cleanup()
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => chmodSync(root, 0o700));
    expect(failure).toMatchObject({ code: 'EACCES', path: locked });
  });
});
