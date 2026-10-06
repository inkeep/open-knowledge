import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { gitCleanEnv } from '../../../../scripts/git-clean-env.mjs';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import { isTestOnlySourceFile } from '../../../../test-support/test-only-source-file.mjs';
import { getRegisteredDescriptors } from '../../src/editor/registry/index.ts';

const OK_ROOT = resolve(import.meta.dirname, '../../../..');
const SELF_FILE = resolve(import.meta.dirname, 'substrate-vocabulary-drift.uncached.test.ts');

const TEST_FIXTURE_KNOWN_NONREGISTERED: Record<string, string> = {
  mermaid:
    'Mermaid.tsx — renders MermaidFence compat with substrate-type="mermaid" for DOM targeting',
};

const COMPONENT_TYPE_LITERAL = /data-component-type="([^"'$]+)"|data-component-type='([^"'$]+)'/g;

interface Reference {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

function listPackageTestFiles(root: string): string[] {
  return testFilesFromListing(
    root,
    spawnSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages'],
      {
        cwd: root,
        encoding: 'utf8',
        env: gitCleanEnv(),
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
    ),
  );
}

function testFilesFromListing(root: string, listed: SpawnSyncReturns<string>): string[] {
  if (listed.error || listed.status !== 0 || listed.stderr.trim() !== '') {
    const cause =
      listed.error?.message ??
      `status ${listed.status}, signal ${listed.signal}, stderr ${JSON.stringify(listed.stderr.trim())}`;
    throw new Error(
      `git ls-files could not list every file under ${join(root, 'packages')} (${cause}), so the substrate vocabulary gate cannot see the test files it checks.`,
    );
  }
  return listed.stdout
    .split('\0')
    .filter((path) => {
      const name = basename(path);
      return (
        (isTestOnlySourceFile(name, 'vitest') || isTestOnlySourceFile(name, 'playwright')) &&
        statSync(join(root, path), { throwIfNoEntry: false }) !== undefined
      );
    })
    .map((path) => join(root, path));
}

function registeredNames(): Set<string> {
  const registered = new Set<string>();
  for (const d of getRegisteredDescriptors()) {
    registered.add(d.name.toLowerCase());
  }
  registered.add('*');
  return registered;
}

function findReferences(files: readonly string[]): Reference[] {
  const references: Reference[] = [];
  for (const file of files) {
    if (file === SELF_FILE) continue;
    const lines = readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      COMPONENT_TYPE_LITERAL.lastIndex = 0;
      let match: RegExpExecArray | null = COMPONENT_TYPE_LITERAL.exec(line);
      while (match !== null) {
        const name = match[1] ?? match[2];
        if (name && name !== '...') {
          references.push({ file, line: i + 1, name: name.toLowerCase() });
        }
        match = COMPONENT_TYPE_LITERAL.exec(line);
      }
    }
  }
  return references;
}

function unresolvedReferences(
  references: readonly Reference[],
  registered: ReadonlySet<string>,
): Reference[] {
  return references.filter(
    ({ name }) => !registered.has(name) && !(name in TEST_FIXTURE_KNOWN_NONREGISTERED),
  );
}

function runGit(root: string, args: readonly string[]): void {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: gitCleanEnv(),
    windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
}

describe('substrate vocabulary drift — every test reference must resolve', () => {
  test('every `data-component-type="<name>"` literal is a registered descriptor or a known exception', () => {
    const references = findReferences(listPackageTestFiles(OK_ROOT));
    expect(
      references.length,
      'git lists no test file under packages/ that holds a data-component-type literal, so this ' +
        'gate would pass having checked nothing',
    ).toBeGreaterThan(0);

    const violations = unresolvedReferences(references, registeredNames());

    if (violations.length > 0) {
      const lines = violations.map(
        (v) =>
          `  - ${v.file}:${v.line} references data-component-type="${v.name}" — not registered. ` +
          `Resolution: (a) update the test reference to a registered substrate name; ` +
          `(b) add "${v.name}" to TEST_FIXTURE_KNOWN_NONREGISTERED in ` +
          `tests/meta/substrate-vocabulary-drift.uncached.test.ts with a comment naming the production source.`,
      );
      throw new Error(
        `Substrate-vocabulary drift detected (${violations.length} reference${
          violations.length === 1 ? '' : 's'
        }):\n${lines.join('\n')}`,
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('flags an unregistered literal in an untracked test file git lists under packages/, and not in an ignored directory, a non-test file or outside packages/ (planted positive)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-substrate-vocabulary-drift-'));
    try {
      runGit(root, ['init', '-q']);
      configureTestGitRepository(root);
      const unregistered = `export const markup = '<div data-component-type="planted-unregistered-substrate"></div>';\n`;
      const plant = (path: string, content: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      };
      plant('.gitignore', 'ignored/\n');
      plant(join('packages', 'new', 'tests', 'stray.test.ts'), unregistered);
      plant(join('packages', 'new', 'src', 'clean.test.ts'), 'export const clean = true;\n');
      plant(join('packages', 'new', 'src', 'source.ts'), unregistered);
      plant(join('packages', 'new', 'ignored', 'hidden.test.ts'), unregistered);
      plant(join('elsewhere', 'outside.test.ts'), unregistered);

      const files = listPackageTestFiles(root);

      expect(files.map((file) => relative(root, file)).sort()).toEqual([
        join('packages', 'new', 'src', 'clean.test.ts'),
        join('packages', 'new', 'tests', 'stray.test.ts'),
      ]);
      expect(
        unresolvedReferences(findReferences(files), registeredNames()).map(({ file, name }) => [
          relative(root, file),
          name,
        ]),
      ).toEqual([
        [join('packages', 'new', 'tests', 'stray.test.ts'), 'planted-unregistered-substrate'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws when git exits 0 but warns it could not read a .gitignore under packages/ (planted positive)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-substrate-vocabulary-drift-'));
    try {
      runGit(root, ['init', '-q']);
      configureTestGitRepository(root);
      const dir = join(root, 'packages', 'a');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ignore-rules'), 'ignored/\n');
      symlinkSync('ignore-rules', join(dir, '.gitignore'));

      expect(() => listPackageTestFiles(root)).toThrow(
        /status 0, signal null, stderr ".*unable to access/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws when a test file git lists sits behind a symlink loop (planted positive)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-substrate-vocabulary-drift-'));
    try {
      runGit(root, ['init', '-q']);
      configureTestGitRepository(root);
      const tests = join(root, 'packages', 'p', 'tests');
      mkdirSync(tests, { recursive: true });
      writeFileSync(join(tests, 'loop.test.ts'), '');
      runGit(root, ['add', 'packages']);
      rmSync(tests, { recursive: true });
      symlinkSync('tests', tests);

      expect(() => listPackageTestFiles(root)).toThrow(/ELOOP/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws when the root is not a git work tree (planted positive)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-substrate-vocabulary-drift-'));
    try {
      expect(() => listPackageTestFiles(root)).toThrow(
        /status 128, signal null, stderr "fatal: not a git repository/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws on a listing that was killed by a signal or exited non-zero without writing stderr, and accepts a clean one (planted positive)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-substrate-vocabulary-drift-'));
    try {
      const listed = join('packages', 'p', 'tests', 'listed.test.ts');
      mkdirSync(dirname(join(root, listed)), { recursive: true });
      writeFileSync(join(root, listed), '');
      const result = (
        status: number | null,
        signal: SpawnSyncReturns<string>['signal'],
      ): SpawnSyncReturns<string> => ({
        pid: 0,
        output: [],
        stdout: `${listed}\0`,
        stderr: '',
        status,
        signal,
      });

      expect(() => testFilesFromListing(root, result(null, 'SIGKILL'))).toThrow(
        /status null, signal SIGKILL, stderr ""/,
      );
      expect(() => testFilesFromListing(root, result(1, null))).toThrow(
        /status 1, signal null, stderr ""/,
      );
      expect(testFilesFromListing(root, result(0, null))).toEqual([join(root, listed)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
