import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathspecArgs } from '@inkeep/open-knowledge-core';
import simpleGit, { type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { isPathTrackedInGit } from './git-tracked-paths.ts';

const fixtures: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function write(dir: string, relPath: string): void {
  mkdirSync(dirname(join(dir, relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), `${relPath}\n`);
}

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'ok-tracked-paths-'));
  fixtures.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  configureTestGitRepository(repo);
  return repo;
}

function settleIndex(): void {
  vi.setSystemTime(Date.now() + 60_000);
}

function observedGit(dir: string): { git: SimpleGit; queries: () => string[][] } {
  const queries: string[][] = [];
  const runner = simpleGit({ baseDir: dir }).outputHandler((_command, _stdout, _stderr, args) => {
    if (args[0] === 'ls-files')
      queries.push(args.filter((arg) => arg !== 'ls-files' && arg !== '-z'));
  });
  return { git: runner, queries: () => queries };
}

const askedAbout = (path: string): string[] => pathspecArgs([path]);
const listedFolder = (scope: string): string[] => (scope === '' ? [] : pathspecArgs([scope]));

describe('isPathTrackedInGit', () => {
  const answerRows = [
    { path: 'notes/tracked.md', scope: 'notes', tracked: true },
    { path: 'notes', scope: '', tracked: true },
    { path: 'notes/deep', scope: 'notes', tracked: true },
    { path: 'notes/untracked.md', scope: 'notes', tracked: false },
    { path: 'drafts', scope: '', tracked: false },
    { path: 'drafts/loose.md', scope: 'drafts', tracked: false },
    { path: ':colon/tracked.md', scope: ':colon', tracked: true },
    { path: 'top.md', scope: '', tracked: true },
  ];

  function seedAnswerRepo(): string {
    const repo = createRepo();
    for (const file of ['notes/tracked.md', 'notes/deep/inner.md', ':colon/tracked.md', 'top.md']) {
      write(repo, file);
    }
    git(repo, ['add', '--', 'notes', ':(literal):colon', 'top.md']);
    write(repo, 'notes/untracked.md');
    write(repo, 'drafts/loose.md');
    return repo;
  }

  test.each(answerRows)(
    'answers $tracked for $path when asked alone',
    async ({ path, tracked }) => {
      const repo = seedAnswerRepo();
      const { git: runner, queries } = observedGit(repo);

      expect(await isPathTrackedInGit(runner, repo, path)).toBe(tracked);
      expect(queries()).toEqual([askedAbout(path)]);
    },
  );

  test.each(answerRows)(
    'answers $tracked for $path from a folder listing',
    async ({ path, scope, tracked }) => {
      const repo = seedAnswerRepo();
      settleIndex();
      const { git: runner, queries } = observedGit(repo);
      const sibling = scope === '' ? 'absent.md' : `${scope}/absent.md`;

      expect(await isPathTrackedInGit(runner, repo, sibling)).toBe(false);
      expect(await isPathTrackedInGit(runner, repo, path)).toBe(tracked);
      expect(queries()).toEqual([askedAbout(sibling), listedFolder(scope)]);
    },
  );

  test('answers from a project directory below the repository root', async () => {
    const repo = createRepo();
    write(repo, 'project/notes/tracked.md');
    git(repo, ['add', '--', 'project']);
    write(repo, 'project/notes/untracked.md');
    settleIndex();
    const projectDir = join(repo, 'project');
    const { git: runner, queries } = observedGit(projectDir);

    expect(await isPathTrackedInGit(runner, projectDir, 'notes/tracked.md')).toBe(true);
    expect(await isPathTrackedInGit(runner, projectDir, 'notes/untracked.md')).toBe(false);
    expect(queries()).toEqual([askedAbout('notes/tracked.md'), listedFolder('notes')]);
  });

  test('answers a run of lookups in one folder from one listing', async () => {
    const repo = createRepo();
    const names = ['a', 'b', 'c', 'd', 'e'];
    for (const name of names) write(repo, `notes/${name}.md`);
    git(repo, ['add', '--', 'notes/a.md']);
    settleIndex();
    const { git: runner, queries } = observedGit(repo);

    const answers = [];
    for (const name of names)
      answers.push(await isPathTrackedInGit(runner, repo, `notes/${name}.md`));

    expect(answers).toEqual([true, false, false, false, false]);
    expect(queries()).toEqual([askedAbout('notes/a.md'), listedFolder('notes')]);
  });

  test.each(['notes', ''])(
    'asks about each path alone in a run of tracked moves out of "%s"',
    async (folder) => {
      const repo = createRepo();
      const paths = ['a', 'b', 'c'].map((name) =>
        folder === '' ? `${name}.md` : `${folder}/${name}.md`,
      );
      for (const path of paths) write(repo, path);
      git(repo, ['add', '--', ...paths]);
      mkdirSync(join(repo, 'moved'));
      const { git: runner, queries } = observedGit(repo);

      const answers = [];
      for (const path of paths) {
        settleIndex();
        answers.push(await isPathTrackedInGit(runner, repo, path));
        git(repo, ['mv', '--', path, `moved/${path.replaceAll('/', '-')}`]);
      }

      expect(answers).toEqual([true, true, true]);
      expect(queries()).toEqual(paths.map(askedAbout));
    },
  );

  test('answers a lookup in another folder from that folder', async () => {
    const repo = createRepo();
    for (const path of ['notes/a.md', 'notes/b.md', 'other/tracked.md']) write(repo, path);
    git(repo, ['add', '--', 'other/tracked.md']);
    settleIndex();
    const { git: runner } = observedGit(repo);

    expect(await isPathTrackedInGit(runner, repo, 'notes/a.md')).toBe(false);
    expect(await isPathTrackedInGit(runner, repo, 'notes/b.md')).toBe(false);
    expect(await isPathTrackedInGit(runner, repo, 'other/tracked.md')).toBe(true);
  });

  test('answers as git does for a name spelled in another Unicode normalization form', async () => {
    const repo = createRepo();
    const composed = 'notes/café.md';
    const decomposed = composed.normalize('NFD');
    write(repo, 'notes/a.md');
    write(repo, composed);
    git(repo, ['add', ...pathspecArgs([composed])]);
    settleIndex();
    const { git: runner, queries } = observedGit(repo);
    const gitAnswer = git(repo, ['ls-files', ...pathspecArgs([decomposed])]) !== '';

    expect(await isPathTrackedInGit(runner, repo, 'notes/a.md')).toBe(false);
    expect(await isPathTrackedInGit(runner, repo, decomposed)).toBe(gitAnswer);
    expect(queries()).toEqual([askedAbout('notes/a.md'), askedAbout(decomposed)]);
  });

  test('answers from the index once another writer changes it', async () => {
    const repo = createRepo();
    write(repo, 'notes/seed.md');
    git(repo, ['add', '--', 'notes/seed.md']);
    write(repo, 'notes/later.md');
    settleIndex();
    const { git: runner } = observedGit(repo);

    expect(await isPathTrackedInGit(runner, repo, 'notes/seed.md')).toBe(true);
    expect(await isPathTrackedInGit(runner, repo, 'notes/later.md')).toBe(false);
    git(repo, ['add', '--', 'notes/later.md']);
    settleIndex();
    expect(await isPathTrackedInGit(runner, repo, 'notes/later.md')).toBe(true);
  });

  test('asks about each path alone while the index was written within the timestamp granularity', async () => {
    const repo = createRepo();
    for (const name of ['a', 'b', 'c']) write(repo, `notes/${name}.md`);
    git(repo, ['add', '--', 'notes/a.md']);
    const { git: runner, queries } = observedGit(repo);

    for (const name of ['a', 'b', 'c']) await isPathTrackedInGit(runner, repo, `notes/${name}.md`);

    expect(queries()).toEqual(['a', 'b', 'c'].map((name) => askedAbout(`notes/${name}.md`)));
  });

  test('answers untracked without asking git when the repository has no index', async () => {
    const repo = createRepo();
    write(repo, 'notes/loose.md');
    const { git: runner, queries } = observedGit(repo);

    expect(await isPathTrackedInGit(runner, repo, 'notes/loose.md')).toBe(false);
    expect(queries()).toEqual([]);
  });
});
