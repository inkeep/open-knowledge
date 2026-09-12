import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import * as scope from './scope.mjs';
import { discoverInScopeFiles, discoverInScopeFilesWithSkips } from './scope.mjs';

const roots = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function file(root, relPath, contents = 'export const a = 1;\n') {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function link(root, relPath, target) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  symlinkSync(target, abs);
}

const ADOPTER_CONFIG = {
  version: 1,
  families: {
    typescript: { extensions: ['.ts'], extractor: 'c-family' },
    'esm-script': { extensions: ['.mjs'], extractor: 'c-family' },
  },
  units: [
    { id: 'packages-src', family: 'typescript', roots: ['packages/**/src'] },
    { id: 'docs', family: 'typescript', roots: ['docs'] },
    { id: 'root-configs', family: 'typescript', roots: ['.'] },
    { id: 'scripts', family: 'esm-script', roots: ['scripts'] },
    { id: 'lint-plugins', family: 'esm-script', roots: ['lint-plugins'] },
  ],
  exclude: ['**/node_modules/**'],
};

function adopterRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  writeFileSync(join(root, 'no-comments.config.jsonc'), JSON.stringify(ADOPTER_CONFIG, null, 2));
  return root;
}

function syntheticRoot() {
  const root = adopterRoot('no-comments-symlinks-');

  file(root, 'packages/realpkg/src/real.ts');
  file(root, 'scripts/real.mjs');
  file(root, 'scripts/notes.txt', 'not a source file\n');
  file(root, 'real-root-config.ts');
  file(root, 'real-target-file.mjs');
  file(root, 'real-target-dir/src/inner.ts');
  file(root, 'real-docs-target/page.ts');

  link(root, 'scripts/linked.mjs', '../real-target-file.mjs');
  link(root, 'packages/linkedpkg', '../real-target-dir');
  link(root, 'lint-plugins/linkdir.mjs', '../real-target-dir');
  link(root, 'linked-root.ts', 'real-root-config.ts');
  link(root, 'dangling-root.ts', 'nowhere-at-all.ts');
  link(root, 'docs', 'real-docs-target');
  link(root, 'scripts/broken.mjs', 'nowhere-at-all.mjs');

  file(root, 'packages/realpkg/node_modules/dep/src/dep.ts');
  link(root, 'packages/realpkg/node_modules/loop', '../../..');

  return root;
}

const realFs = { readdirSync, statSync, lstatSync };

describe('discovery over a root that carries every symlink shape', () => {
  const root = syntheticRoot();
  const result = discoverInScopeFilesWithSkips(root, realFs);

  test('the real in-scope files are still found, and the out-of-scope sibling is not', () => {
    expect(result.files).toStrictEqual([
      'packages/realpkg/src/real.ts',
      'real-root-config.ts',
      'scripts/real.mjs',
    ]);
  });

  test('every symlink that would have contributed to discovery is a recorded skip', () => {
    expect(result.skips).toStrictEqual([
      { path: 'dangling-root.ts', reason: 'symlink' },
      { path: 'docs', reason: 'symlink' },
      { path: 'linked-root.ts', reason: 'symlink' },
      { path: 'lint-plugins/linkdir.mjs', reason: 'symlink' },
      { path: 'packages/linkedpkg', reason: 'symlink-directory' },
      { path: 'scripts/broken.mjs', reason: 'symlink' },
      { path: 'scripts/linked.mjs', reason: 'symlink' },
    ]);
  });

  test('the public discoverer refuses the root rather than reporting a short list as clean', () => {
    expect(() => discoverInScopeFiles(root, realFs)).toThrow(/discovery could not read 7/);
  });

  test('the remedy the refusal names is a function a caller can import', () => {
    expect(() => discoverInScopeFiles(root, realFs)).toThrow(/discoverInScopeFilesWithSkips/);
    expect(typeof scope.discoverInScopeFilesWithSkips).toBe('function');
  });
});

describe('a directory the exclude names is pruned, not walked and filtered', () => {
  const root = syntheticRoot();
  const prune = scope.scopeForRoot(root).pruneDirectories;

  const observe = () => {
    const pruned = [];
    const read = [];
    const result = discoverInScopeFilesWithSkips(root, {
      readdirSync: (dir) => {
        read.push(dir);
        const entries = readdirSync(dir);
        for (const entry of entries) if (prune.has(entry)) pruned.push(entry);
        return entries;
      },
      statSync,
      lstatSync,
    });
    return { pruned, read, result };
  };

  test('the walk meets the vendored tree and prunes exactly the names the exclude declares', () => {
    expect([...prune]).toStrictEqual(['node_modules']);
    expect(observe().pruned).toStrictEqual(['node_modules']);
  });

  test('no directory inside the pruned tree is ever read, so its link farm cannot be reached', () => {
    const { read, result } = observe();
    expect(read.filter((dir) => dir.includes('node_modules'))).toStrictEqual([]);
    expect(result.files).toStrictEqual([
      'packages/realpkg/src/real.ts',
      'real-root-config.ts',
      'scripts/real.mjs',
    ]);
    expect(result.skips.map((skip) => skip.path)).not.toContain(
      'packages/realpkg/node_modules/loop',
    );
  });
});

describe('a root that declares no scope is refused rather than judged by another tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'no-comments-unscoped-'));
  roots.push(root);
  file(root, 'packages/realpkg/src/real.ts');

  test('discovery names the missing config and the root it looked in', () => {
    expect(() => discoverInScopeFilesWithSkips(root, realFs)).toThrow(/scope-config: NOT FOUND/);
    expect(() => discoverInScopeFilesWithSkips(root, realFs)).toThrow(/no-comments\.config\.jsonc/);
  });
});

describe('the symlink branch cannot be turned off by the caller', () => {
  const root = syntheticRoot();

  test('omitting lstatSync is refused instead of silently following every link', () => {
    expect(() => discoverInScopeFiles(root, { readdirSync, statSync })).toThrow(/lstatSync/);
    expect(() => discoverInScopeFilesWithSkips(root, { readdirSync, statSync })).toThrow(
      /lstatSync/,
    );
  });

  test('omitting statSync is refused too, since a link to a directory needs a follow', () => {
    expect(() => discoverInScopeFiles(root, { readdirSync, lstatSync })).toThrow(/statSync/);
  });
});

describe('a tree with no symlinks discovers cleanly', () => {
  const root = adopterRoot('no-comments-nosymlinks-');
  file(root, 'packages/realpkg/src/real.ts');
  file(root, 'scripts/real.mjs');

  test('no skip is recorded and the public discoverer returns', () => {
    expect(discoverInScopeFilesWithSkips(root, realFs).skips).toStrictEqual([]);
    expect(discoverInScopeFiles(root, realFs)).toStrictEqual([
      'packages/realpkg/src/real.ts',
      'scripts/real.mjs',
    ]);
  });
});

describe('a declared file that exists but cannot be read is refused, never dropped', () => {
  const declaringRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'no-comments-unreadable-'));
    roots.push(root);
    writeFileSync(
      join(root, 'no-comments.config.jsonc'),
      JSON.stringify({
        version: 1,
        families: { shell: { extensions: ['.sh'], extractor: 'hash-family' } },
        units: [
          {
            id: 'shell',
            family: 'shell',
            roots: ['scripts'],
            files: ['.husky/pre-commit', '.husky/never-written'],
          },
        ],
        exclude: [],
      }),
    );
    file(root, 'scripts/build.sh', '#!/usr/bin/env bash\n');
    file(root, '.husky/pre-commit', '#!/usr/bin/env bash\n');
    return root;
  };

  const unreadable = (relPath, code) => ({
    readdirSync,
    statSync,
    lstatSync: (path) => {
      if (String(path).endsWith(`/${relPath}`)) {
        const error = new Error(`${code}: simulated failure, lstat '${path}'`);
        error.code = code;
        throw error;
      }
      return lstatSync(path);
    },
  });

  test('the unreadable entry becomes a skip carrying its errno, distinct from declared-absent', () => {
    const root = declaringRoot();
    const result = discoverInScopeFilesWithSkips(root, unreadable('.husky/pre-commit', 'EACCES'));
    expect(result.skips).toStrictEqual([{ path: '.husky/pre-commit', reason: 'EACCES' }]);
    expect(result.files).toStrictEqual(['scripts/build.sh']);
    expect(result.declaredAbsent).toStrictEqual([
      { unit: 'shell', kind: 'file', path: '.husky/never-written' },
    ]);
  });

  test('the public discoverer refuses the root rather than reporting the short list as clean', () => {
    const root = declaringRoot();
    expect(() => discoverInScopeFiles(root, unreadable('.husky/pre-commit', 'EACCES'))).toThrow(
      /\.husky\/pre-commit \(EACCES\)/,
    );
  });

  test('an errno-less read failure still records a skip instead of vanishing', () => {
    const root = declaringRoot();
    const brokenFs = {
      readdirSync,
      statSync,
      lstatSync: (path) => {
        if (String(path).endsWith('/.husky/pre-commit')) throw new Error('no errno on this one');
        return lstatSync(path);
      },
    };
    expect(discoverInScopeFilesWithSkips(root, brokenFs).skips).toStrictEqual([
      { path: '.husky/pre-commit', reason: 'stat-failed' },
    ]);
  });

  test('ENOENT from that same call site stays silent, so a merely absent file is no error', () => {
    const root = declaringRoot();
    expect(
      discoverInScopeFilesWithSkips(root, unreadable('.husky/pre-commit', 'ENOENT')).skips,
    ).toStrictEqual([]);
    expect(discoverInScopeFiles(root, unreadable('.husky/pre-commit', 'ENOENT'))).toStrictEqual([
      'scripts/build.sh',
    ]);
  });

  test('the genuinely absent declared file is silent against the real filesystem too', () => {
    const root = declaringRoot();
    expect(discoverInScopeFilesWithSkips(root, realFs).skips).toStrictEqual([]);
    expect(discoverInScopeFiles(root, realFs)).toStrictEqual([
      '.husky/pre-commit',
      'scripts/build.sh',
    ]);
  });
});
