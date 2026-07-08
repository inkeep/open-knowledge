import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import {
  listNameStatus,
  listNames,
  listPorcelainPaths,
  listTreeLongEntries,
  parseNameStatusZ,
  parsePorcelainPaths,
  parseTreeLongEntriesZ,
  splitNulSeparatedPaths,
} from './git-paths.ts';

// A name git C-quotes in its default (non-`-z`) output — the failure the whole
// module exists to prevent.
const NON_ASCII = 'hyvää yötä.md';

describe('splitNulSeparatedPaths', () => {
  test('empty input yields no paths', () => {
    expect(splitNulSeparatedPaths('')).toEqual([]);
  });

  test('drops the empty field after a trailing NUL', () => {
    expect(splitNulSeparatedPaths('a.md\0b.md\0')).toEqual(['a.md', 'b.md']);
  });

  test('preserves non-ASCII bytes verbatim', () => {
    expect(splitNulSeparatedPaths(`${NON_ASCII}\0`)).toEqual([NON_ASCII]);
  });
});

describe('parsePorcelainPaths', () => {
  test('empty input yields no paths', () => {
    expect(parsePorcelainPaths('')).toEqual([]);
  });

  test('reads the path after the XY status prefix', () => {
    expect(parsePorcelainPaths(' M a.md\0')).toEqual(['a.md']);
  });

  test('skips the origin record following a rename', () => {
    // `R  <new>\0<old>\0` — the origin path is a prefix-less following record.
    expect(parsePorcelainPaths('R  new.md\0old.md\0')).toEqual(['new.md']);
  });

  test('skips the origin record following a copy', () => {
    expect(parsePorcelainPaths('C  copy.md\0src.md\0')).toEqual(['copy.md']);
  });

  test('keeps non-ASCII names intact', () => {
    expect(parsePorcelainPaths(` M ${NON_ASCII}\0`)).toEqual([NON_ASCII]);
  });

  test('ignores records shorter than a status prefix', () => {
    expect(parsePorcelainPaths('\0 M a.md\0')).toEqual(['a.md']);
  });
});

describe('parseNameStatusZ', () => {
  test('non-rename row: from and to are the single path', () => {
    expect(parseNameStatusZ('D\0a.md\0')).toEqual([{ status: 'D', from: 'a.md', to: 'a.md' }]);
  });

  test('rename row carries distinct from/to', () => {
    expect(parseNameStatusZ('R100\0old.md\0new.md\0')).toEqual([
      { status: 'R100', from: 'old.md', to: 'new.md' },
    ]);
  });

  test('copy row carries distinct from/to', () => {
    expect(parseNameStatusZ('C90\0src.md\0copy.md\0')).toEqual([
      { status: 'C90', from: 'src.md', to: 'copy.md' },
    ]);
  });

  test('reads a mixed rename + non-rename field stream', () => {
    expect(parseNameStatusZ('R100\0old.md\0new.md\0M\0other.md\0')).toEqual([
      { status: 'R100', from: 'old.md', to: 'new.md' },
      { status: 'M', from: 'other.md', to: 'other.md' },
    ]);
  });

  test('keeps non-ASCII from/to intact', () => {
    expect(parseNameStatusZ(`R100\0${NON_ASCII}\0renamed ${NON_ASCII}\0`)).toEqual([
      { status: 'R100', from: NON_ASCII, to: `renamed ${NON_ASCII}` },
    ]);
  });

  test('empty input yields no rows', () => {
    expect(parseNameStatusZ('')).toEqual([]);
  });
});

describe('parseTreeLongEntriesZ', () => {
  test('reads metadata and raw path from ls-tree --long output', () => {
    const object = 'f'.repeat(40);
    expect(parseTreeLongEntriesZ(`100644 blob ${object} 12\t${NON_ASCII}\0`)).toEqual([
      { mode: '100644', type: 'blob', object, size: 12, path: NON_ASCII },
    ]);
  });

  test('maps a dash size to 0 for non-blob entries', () => {
    const object = 'a'.repeat(40);

    expect(parseTreeLongEntriesZ(`040000 tree ${object} -\tdocs/\0`)).toEqual([
      { mode: '040000', type: 'tree', object, size: 0, path: 'docs/' },
    ]);
  });

  test('empty input yields no entries', () => {
    expect(parseTreeLongEntriesZ('')).toEqual([]);
  });
});

describe('path-listing wrappers (real git)', () => {
  let projectDir: string;

  function run(cmd: string): string {
    return execSync(cmd, { cwd: projectDir, encoding: 'utf8' });
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ok-git-paths-test-'));
    run('git init -q -b main');
    run('git config user.email "test@example.com"');
    run('git config user.name "Test"');
    run('git config commit.gpgsign false');
    run('git config core.quotepath true');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('listNames returns the real UTF-8 path from ls-tree (no C-quoting)', async () => {
    writeFileSync(join(projectDir, NON_ASCII), 'x\n');
    run('git add -A');
    run('git commit -q -m init');

    const paths = await listNames(simpleGit(projectDir), ['ls-tree', '-r', '--name-only', 'HEAD']);

    expect(paths).toEqual([NON_ASCII]);
  });

  test('listNames places -z before a -- pathspec separator', async () => {
    writeFileSync(join(projectDir, NON_ASCII), 'x\n');
    run('git add -A');
    run('git commit -q -m init');

    const paths = await listNames(simpleGit(projectDir), [
      'ls-tree',
      '-r',
      '--name-only',
      'HEAD',
      '--',
      NON_ASCII,
    ]);

    expect(paths).toEqual([NON_ASCII]);
  });

  test('listTreeLongEntries returns the real UTF-8 path and blob size', async () => {
    writeFileSync(join(projectDir, NON_ASCII), 'x\n');
    run('git add -A');
    run('git commit -q -m init');

    const entries = await listTreeLongEntries(simpleGit(projectDir), [
      'ls-tree',
      '-r',
      '--long',
      'HEAD',
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe(NON_ASCII);
    expect(entries[0]?.size).toBe(2);
  });

  test('listPorcelainPaths reports a non-ASCII working-tree change by its real name', async () => {
    writeFileSync(join(projectDir, NON_ASCII), 'x\n');

    const paths = await listPorcelainPaths(simpleGit(projectDir));

    expect(paths).toContain(NON_ASCII);
  });

  test('listPorcelainPaths reports only the destination of a staged non-ASCII rename', async () => {
    writeFileSync(join(projectDir, NON_ASCII), 'x\n');
    run('git add -A');
    run('git commit -q -m init');
    const renamed = `renamed ${NON_ASCII}`;
    run(`git mv "${NON_ASCII}" "${renamed}"`);

    const paths = await listPorcelainPaths(simpleGit(projectDir));

    expect(paths).toEqual([renamed]);
  });

  test('listNameStatus classifies a non-ASCII rename with real from/to paths', async () => {
    writeFileSync(join(projectDir, NON_ASCII), 'x\n');
    run('git add -A');
    run('git commit -q -m init');
    const renamed = `renamed ${NON_ASCII}`;
    run(`git mv "${NON_ASCII}" "${renamed}"`);
    run('git commit -q -m rename');

    const rows = await listNameStatus(simpleGit(projectDir), [
      'diff-tree',
      '-M',
      '-r',
      '--no-commit-id',
      '--name-status',
      'HEAD^1',
      'HEAD',
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status.startsWith('R')).toBe(true);
    expect(rows[0]?.from).toBe(NON_ASCII);
    expect(rows[0]?.to).toBe(renamed);
  });
});
