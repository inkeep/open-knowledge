import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ATOMIC_TEMP_GLOB,
  ATOMIC_TEMP_INFIX,
  ATOMIC_TEMP_PATH_RE,
  atomicTempPath,
} from './atomic-temp-path.ts';

const UUID = '0123abcd-0123-0123-0123-0123456789ab';
const PRODUCER_BASE = 'notes/a.md';
const PRODUCED_SUFFIX = atomicTempPath(PRODUCER_BASE).slice(PRODUCER_BASE.length);

const MATCHING: ReadonlyArray<readonly [string, string]> = [
  [`notes/a.md${PRODUCED_SUFFIX}`, 'suffix taken from a real atomicTempPath() call'],
  [`notes/a.md.tmp.${UUID}`, 'hand-written instance of the same shape'],
  [`notes/a b.md.tmp.${UUID}`, 'space in the basename'],
  [`dir/.tmp.${UUID}`, 'whole basename is the infix plus uuid'],
];

const REJECTED: ReadonlyArray<readonly [string, string]> = [
  ['notes/a.md', 'no temp infix at all'],
  [`notes/a.md.tmpX${UUID}`, 'non-dot character in the second dot position'],
  [`notes/a.md.tmp_${UUID}`, 'underscore in the second dot position'],
  [`notes/a.mdXtmp.${UUID}`, 'non-dot character in the first dot position'],
  ['notes/a.md.tmp.12345.1699999999999', 'the .tmp.<pid>.<ms> shape other writers produced'],
  [`notes/a.md.tmp.${UUID}.bak`, 'trailing suffix after the uuid'],
  ['notes/a.md.tmp.', 'infix with nothing after it'],
  ['notes/a.md.tmp.0123abc-0123-0123-0123-0123456789ab', 'first hex group one short'],
  ['notes/a.md.tmp.0123abcde-0123-0123-0123-0123456789ab', 'first hex group one long'],
  ['notes/a.md.tmp.0123abcd-0123-0123-0123-0123456789abc', 'last hex group one long'],
  ['notes/a.md.tmp.0123abcd-0123-0123-0123456789ab', 'one hex group missing'],
  ['notes/a.md.tmp.0123abcz-0123-0123-0123-0123456789ab', 'non-hex character in a group'],
  ['notes/a.md.tmp.0123ABCD-0123-0123-0123-0123456789ab', 'uppercase hex'],
  [
    'notes/a.md.tmp.0123abcd_0123-0123-0123-0123456789ab',
    'underscore where a group separator belongs',
  ],
];

const LEAF_CANDIDATES: readonly string[] = [
  ...MATCHING.map(([path]) => path),
  ...REJECTED.map(([path]) => path),
];

const DESCENDANT_OF_TEMP_DIR = `notes/a.md.tmp.${UUID}/inner.md`;
const UPPERCASE_HEX = 'notes/a.md.tmp.0123ABCD-0123-0123-0123-0123456789ab';

let repoDir: string;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function globVerdicts(paths: readonly string[], ignoreCase: boolean): Map<string, boolean> {
  const run = spawnSync(
    'git',
    [
      '-c',
      `core.ignoreCase=${ignoreCase}`,
      'check-ignore',
      '--verbose',
      '--non-matching',
      '-z',
      '--stdin',
    ],
    { cwd: repoDir, env: gitEnv(), encoding: 'utf-8', input: `${paths.join('\0')}\0` },
  );
  if (run.status !== 0 && run.status !== 1) {
    throw new Error(`git check-ignore failed (status ${run.status}): ${run.stderr}`);
  }
  const fields = run.stdout.split('\0');
  fields.pop();
  expect(fields.length).toBe(paths.length * 4);
  const verdicts = new Map<string, boolean>();
  for (let i = 0; i < fields.length; i += 4) {
    verdicts.set(fields[i + 3] ?? '', (fields[i] ?? '') !== '');
  }
  expect(verdicts.size).toBe(paths.length);
  return verdicts;
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'ok-atomic-temp-glob-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'pipe', env: gitEnv() });
  writeFileSync(join(repoDir, '.git', 'info', 'exclude'), `${ATOMIC_TEMP_GLOB}\n`);
});

afterAll(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

describe('ATOMIC_TEMP_PATH_RE', () => {
  for (const [path, why] of MATCHING)
    test(`matches (${why}): ${JSON.stringify(path)}`, () =>
      expect(ATOMIC_TEMP_PATH_RE.test(path)).toBe(true));

  for (const [path, why] of REJECTED)
    test(`rejects (${why}): ${JSON.stringify(path)}`, () =>
      expect(ATOMIC_TEMP_PATH_RE.test(path)).toBe(false));

  test('repeated calls on the same path return the same verdict', () => {
    const path = `notes/a.md.tmp.${UUID}`;
    expect([
      ATOMIC_TEMP_PATH_RE.test(path),
      ATOMIC_TEMP_PATH_RE.test(path),
      ATOMIC_TEMP_PATH_RE.test(path),
    ]).toEqual([true, true, true]);
  });
});

describe('atomicTempPath', () => {
  test('appends to the given path instead of replacing any part of it', () => {
    const given = '/Users/x/Project/notes/My Note.md';
    const produced = atomicTempPath(given);
    expect(produced.slice(0, given.length)).toBe(given);
    expect(produced.slice(given.length).startsWith(ATOMIC_TEMP_INFIX)).toBe(true);
    expect(ATOMIC_TEMP_PATH_RE.test(produced)).toBe(true);
  });

  test('leaves a basename that already contains the infix intact', () => {
    const given = '/Users/x/Project/notes/report.tmp.md';
    const produced = atomicTempPath(given);
    expect(produced.slice(0, given.length)).toBe(given);
    expect(ATOMIC_TEMP_PATH_RE.test(produced)).toBe(true);
  });

  test('two calls for the same target do not collide', () => {
    const given = '/Users/x/Project/notes/a.md';
    expect(atomicTempPath(given)).not.toBe(atomicTempPath(given));
  });
});

describe('ATOMIC_TEMP_GLOB and ATOMIC_TEMP_PATH_RE describe the same shape', () => {
  test('git and the regex return the same verdict for every leaf candidate', () => {
    const verdicts = globVerdicts(LEAF_CANDIDATES, false);
    const byGit = LEAF_CANDIDATES.map((path) => `${path} -> ${verdicts.get(path)}`);
    const byRegex = LEAF_CANDIDATES.map((path) => `${path} -> ${ATOMIC_TEMP_PATH_RE.test(path)}`);
    expect(byGit).toEqual(byRegex);
  });

  test('no candidate is force-removed by the regex while git would still track it', () => {
    const all = [...LEAF_CANDIDATES, DESCENDANT_OF_TEMP_DIR];
    for (const ignoreCase of [false, true]) {
      const verdicts = globVerdicts(all, ignoreCase);
      const regexOnly = all.filter((path) => ATOMIC_TEMP_PATH_RE.test(path) && !verdicts.get(path));
      expect(regexOnly).toEqual([]);
    }
  });

  test('known one-way breadth: git also excludes descendants of a temp-named directory', () => {
    expect(globVerdicts([DESCENDANT_OF_TEMP_DIR], false).get(DESCENDANT_OF_TEMP_DIR)).toBe(true);
    expect(ATOMIC_TEMP_PATH_RE.test(DESCENDANT_OF_TEMP_DIR)).toBe(false);
  });

  test('known one-way breadth: a case-insensitive repo folds the hex classes, the regex does not', () => {
    expect(globVerdicts([UPPERCASE_HEX], true).get(UPPERCASE_HEX)).toBe(true);
    expect(globVerdicts([UPPERCASE_HEX], false).get(UPPERCASE_HEX)).toBe(false);
    expect(ATOMIC_TEMP_PATH_RE.test(UPPERCASE_HEX)).toBe(false);
  });
});
