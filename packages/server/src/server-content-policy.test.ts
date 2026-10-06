import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as projectRoots from './fs/find-project-root.ts';
import {
  assertServerContentPath,
  assertServerContentSubtree,
  canonicalContentPath,
  snapshotServerContentScope,
} from './server-content-policy.ts';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-authority-policy-')));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

test('an unreadable marker does not abandon sibling project exclusions', () => {
  for (const name of ['first', 'second']) {
    mkdirSync(join(root, name, '.ok'), { recursive: true });
    writeFileSync(join(root, name, '.ok', 'config.yml'), '');
  }
  const probe = projectRoots.isProjectRoot;
  let unreadable: string | undefined;
  vi.spyOn(projectRoots, 'isProjectRoot').mockImplementation((path) => {
    if (unreadable === undefined) {
      unreadable = path;
      throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    }
    return probe(path);
  });
  const scope = snapshotServerContentScope(root);
  expect(scope.kind).toBe('tree');
  if (scope.kind !== 'tree') throw new Error('Expected tree scope');
  expect(scope.excluded).toHaveLength(1);
  expect(scope.excluded[0]).not.toBe(unreadable);
});

test('removing a nested marker never expands a captured epoch', () => {
  const child = join(root, 'nested');
  mkdirSync(join(child, '.ok'), { recursive: true });
  writeFileSync(join(child, '.ok', 'config.yml'), '');
  const scope = snapshotServerContentScope(root);
  unlinkSync(join(child, '.ok', 'config.yml'));
  expect(() => assertServerContentPath(scope, join(child, 'new.md'))).toThrow(/nested project/i);
  expect(() => assertServerContentSubtree(scope, root)).toThrow(/nested project/i);
  expect(() => assertServerContentPath(scope, join(root, 'own.md'))).not.toThrow();
});

test.each(['build', 'vendor', 'node_modules', '.cache'])(
  'marked projects inside %s are excluded even when ingestion skips that directory',
  (directory) => {
    const child = join(root, directory, 'nested');
    mkdirSync(join(child, '.ok'), { recursive: true });
    writeFileSync(join(child, '.ok', 'config.yml'), '');
    expect(snapshotServerContentScope(root)).toMatchObject({ kind: 'tree', excluded: [child] });
  },
);

test('a preview admits only its exact physical file, not sibling docs or folders', () => {
  writeFileSync(join(root, 'one.md'), '# One\n');
  symlinkSync(join(root, 'one.md'), join(root, 'alias.md'), 'file');
  const scope = snapshotServerContentScope(root, 'one.md');
  expect(() => assertServerContentPath(scope, join(root, 'alias.md'))).not.toThrow();
  expect(() => assertServerContentPath(scope, join(root, 'two.md'))).toThrow(/does not own/i);
  expect(() => assertServerContentSubtree(scope, root)).toThrow(/does not own/i);
});

test('missing paths retain their suffix when canonicalized through an existing alias', () => {
  mkdirSync(join(root, 'real'));
  symlinkSync(join(root, 'real'), join(root, 'alias'), 'junction');
  expect(canonicalContentPath(join(root, 'alias', 'missing', 'doc.md'))).toBe(
    join(root, 'real', 'missing', 'doc.md'),
  );
});

test('scope paths use the native directory spelling, including missing descendants', () => {
  const directory = join(root, 'ContentCase');
  mkdirSync(directory);
  const native = realpathSync.native(directory);
  expect(snapshotServerContentScope(directory).path).toBe(native);
  expect(canonicalContentPath(join(directory, 'missing', 'note.md'))).toBe(
    join(native, 'missing', 'note.md'),
  );
});
