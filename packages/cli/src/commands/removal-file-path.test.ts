import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resolveRemovalFilePath } from './removal-file-path.ts';

describe('resolveRemovalFilePath', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-removal-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('distinguishes missing files from existing regular files', () => {
    const path = join(dir, 'config');
    expect(resolveRemovalFilePath(path)).toEqual({ kind: 'not-present' });
    writeFileSync(path, 'settings');
    expect(resolveRemovalFilePath(path)).toEqual({ kind: 'ready', path, symlink: false });
  });

  test('declines a directory at the configuration path', () => {
    const path = join(dir, 'config');
    mkdirSync(path);
    expect(resolveRemovalFilePath(path)).toEqual({ kind: 'declined', reason: 'not-a-file' });
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports inaccessible parent-directory permissions without treating the file as absent',
    () => {
      const parent = join(dir, 'private');
      const path = join(parent, 'config');
      mkdirSync(parent);
      writeFileSync(path, 'settings');
      chmodSync(parent, 0o000);
      try {
        expect(resolveRemovalFilePath(path)).toEqual({
          kind: 'declined',
          reason: 'permission-denied',
        });
      } finally {
        chmodSync(parent, 0o700);
      }
    },
  );

  test.skipIf(process.platform === 'win32')('resolves a relative symlink chain', () => {
    const path = join(dir, 'config');
    const target = join(dir, 'target');
    writeFileSync(target, 'settings');
    symlinkSync('target', join(dir, 'intermediate'));
    symlinkSync('intermediate', path);
    expect(resolveRemovalFilePath(path)).toEqual({ kind: 'ready', path: target, symlink: true });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  test.skipIf(process.platform === 'win32').each(['dangling', 'cycle'])(
    'declines a %s symlink without replacing it',
    (kind) => {
      const path = join(dir, 'config');
      symlinkSync(kind === 'cycle' ? 'config' : 'missing', path);
      expect(resolveRemovalFilePath(path)).toEqual({
        kind: 'declined',
        reason: kind === 'cycle' ? 'unresolved-symlink' : 'missing-symlink-target',
      });
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    },
  );
});
