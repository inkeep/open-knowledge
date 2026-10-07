import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { nodeSubstituteFor, resolveBridgePath } from '../foundation/browser-node-compat';

describe('the browser file bridge confines reads to its declared roots', () => {
  let scratch: string;
  let root: string;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ok-file-bridge-')));
    root = join(scratch, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'inside.txt'), 'inside');
    writeFileSync(join(scratch, 'outside.txt'), 'outside');
    symlinkSync(join(scratch, 'outside.txt'), join(root, 'escape.txt'));
    symlinkSync(join(root, 'inside.txt'), join(root, 'alias.txt'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test('a file inside a root resolves to its real path', () => {
    expect(resolveBridgePath(join(root, 'inside.txt'), [root])).toEqual({
      ok: true,
      path: join(root, 'inside.txt'),
    });
  });

  test('a symlink inside a root that points at a file inside it resolves to the target', () => {
    expect(resolveBridgePath(join(root, 'alias.txt'), [root])).toEqual({
      ok: true,
      path: join(root, 'inside.txt'),
    });
  });

  test('a symlink inside a root that points outside every root is refused', () => {
    expect(resolveBridgePath(join(root, 'escape.txt'), [root])).toEqual({
      ok: false,
      status: 403,
      reason: `EACCES: ${join(root, 'escape.txt')} resolves through a symlink outside the declared roots`,
    });
  });

  test('a path outside every root is refused, and so is a dot-dot segment even when it lands inside', () => {
    expect(resolveBridgePath(join(scratch, 'outside.txt'), [root])).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(resolveBridgePath(`${root}/../root/inside.txt`, [root])).toEqual({
      ok: false,
      status: 403,
      reason: `EACCES: ${root}/../root/inside.txt: path traversal is refused`,
    });
  });

  test('a missing file inside a root resolves, so the read reports it as missing', () => {
    expect(resolveBridgePath(join(root, 'absent.txt'), [root])).toEqual({
      ok: true,
      path: join(root, 'absent.txt'),
    });
  });

  test('a relative path is refused as not absolute', () => {
    expect(resolveBridgePath('inside.txt', [root])).toMatchObject({ ok: false, status: 400 });
  });
});

describe('node: imports are substituted for test modules only', () => {
  const APP = '/repo/public/open-knowledge/packages/app';

  test('a test file, a test helper and a test-support module get the substitute', () => {
    for (const importer of [
      `${APP}/src/lib/thing.dom.test.ts`,
      `${APP}/src/test-utils/helper.ts`,
      `${APP}/tests/foundation/case.browser.test.ts`,
      '/repo/public/open-knowledge/test-support/known-bug.test-helper.ts',
    ]) {
      expect(nodeSubstituteFor('node:fs', importer)).toMatch(
        /tests\/foundation\/node-substitutes\/fs\.ts$/,
      );
    }
  });

  test('product source and dependencies keep the unsubstituted builtin', () => {
    expect(nodeSubstituteFor('node:fs', `${APP}/src/lib/thing.ts`)).toBeNull();
    expect(nodeSubstituteFor('node:fs', `${APP}/node_modules/dep/index.test.js`)).toBeNull();
  });

  test('only the six declared modules are substituted', () => {
    expect(
      nodeSubstituteFor('node:child_process', `${APP}/tests/foundation/case.browser.test.ts`),
    ).toBeNull();
    expect(nodeSubstituteFor('fs', `${APP}/tests/foundation/case.browser.test.ts`)).toBeNull();
  });
});
