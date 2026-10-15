import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import { listWorktreeSelector } from './worktree-service.ts';

const execFileAsync = promisify(execFile);
const SETUP_ENV = { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null' };
const BRANCH_COUNT = 40;

const shimRoot = realpathSync(mkdtempSync(join(tmpdir(), 'wt-git-shim-')));
const spawnLog = join(shimRoot, 'spawns.log');
const failRevListFlag = join(shimRoot, 'fail-rev-list');
const originalPath = process.env.PATH;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: SETUP_ENV });
  return String(stdout);
}

function configureRepo(repo: string): void {
  configureTestGitRepository(repo, (args) =>
    execFileSync('git', [...args], { env: SETUP_ENV, stdio: 'pipe' }),
  );
}

interface SpawnStats {
  readonly total: number;
  readonly revList: number;
  readonly maxConcurrentRevList: number;
}

function readSpawnStats(): SpawnStats {
  let total = 0;
  let revList = 0;
  let running = 0;
  let maxConcurrentRevList = 0;
  const revListPids = new Set<string>();
  for (const line of readFileSync(spawnLog, 'utf8').split('\n')) {
    const [event, pid, subcommand] = line.split(' ');
    if (event === 'start') {
      total += 1;
      if (subcommand !== 'rev-list') continue;
      revList += 1;
      revListPids.add(pid ?? '');
      running += 1;
      maxConcurrentRevList = Math.max(maxConcurrentRevList, running);
    } else if (event === 'end' && revListPids.delete(pid ?? '')) {
      running -= 1;
    }
  }
  return { total, revList, maxConcurrentRevList };
}

async function behindCountsFromGit(repo: string, branches: readonly string[]) {
  const out: Record<string, number> = {};
  for (const branch of branches) {
    const n = await git(repo, 'rev-list', '--count', `${branch}..origin/${branch}`);
    out[branch] = Number.parseInt(n.trim(), 10);
  }
  return out;
}

async function listBehindCounts(repo: string): Promise<Record<string, number | undefined>> {
  writeFileSync(spawnLog, '');
  const res = await listWorktreeSelector(repo, repo);
  if (!res.ok) throw new Error(`listWorktreeSelector failed: ${res.reason}`);
  return Object.fromEntries(res.model.entries.map((e) => [e.branch, e.behind]));
}

async function advanceOrigin(repo: string, branch: string, commits: number): Promise<void> {
  let tip = (await git(repo, 'rev-parse', `origin/${branch}`)).trim();
  const tree = (await git(repo, 'rev-parse', `${tip}^{tree}`)).trim();
  for (let i = 0; i < commits; i += 1) {
    tip = (await git(repo, 'commit-tree', tree, '-p', tip, '-m', `${branch} ahead ${i}`)).trim();
  }
  await git(repo, 'push', 'origin', `${tip}:refs/heads/${branch}`);
}

describe.skipIf(process.platform === 'win32')('worktree behind counts: git spawns', () => {
  let root: string | null = null;
  let repo = '';
  let branches: string[] = [];

  beforeAll(() => {
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { env: SETUP_ENV })
      .toString()
      .trim();
    const shimDir = join(shimRoot, 'bin');
    mkdirSync(shimDir);
    writeFileSync(
      join(shimDir, 'git'),
      [
        '#!/bin/sh',
        `printf 'start %s %s\\n' "$$" "$1" >> '${spawnLog}'`,
        `if [ "$1" = rev-list ] && [ -f '${failRevListFlag}' ]; then printf 'end %s\\n' "$$" >> '${spawnLog}'; exit 1; fi`,
        `'${realGit}' "$@"`,
        'status=$?',
        `printf 'end %s\\n' "$$" >> '${spawnLog}'`,
        'exit $status',
        '',
      ].join('\n'),
    );
    chmodSync(join(shimDir, 'git'), 0o755);
    process.env.PATH = `${shimDir}${delimiter}${originalPath ?? ''}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(shimRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(failRevListFlag, { force: true });
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  async function makeRepoWithBranches(): Promise<void> {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-behind-')));
    repo = join(root, 'main');
    mkdirSync(repo);
    await git(repo, 'init', '--initial-branch=main', '.');
    configureRepo(repo);
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), '# main\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'initial');
    branches = ['main'];
    for (let i = 0; i < BRANCH_COUNT; i += 1) {
      await git(repo, 'commit', '--allow-empty', '-m', `commit ${i}`);
      const n = String(i).padStart(2, '0');
      const branch = i % 5 === 1 ? `team/fix/item-${n}` : `feature-${n}`;
      await git(repo, 'branch', branch);
      branches.push(branch);
    }
    await git(repo, 'commit', '--allow-empty', '-m', 'main tip');
    await git(repo, 'branch', 'local-only');
    const bare = join(root, 'origin.git');
    await git(repo, 'init', '--bare', '--initial-branch=main', bare);
    configureRepo(bare);
    await git(repo, 'remote', 'add', 'origin', bare);
    await git(repo, 'push', 'origin', ...branches);
    await git(repo, 'fetch', 'origin');
  }

  test('a cold load counts each ref pair once with at most 8 rev-list processes running', async () => {
    await makeRepoWithBranches();
    const behind = await listBehindCounts(repo);
    const stats = readSpawnStats();
    expect(stats.revList).toBe(branches.length);
    expect(stats.maxConcurrentRevList).toBeGreaterThan(0);
    expect(stats.maxConcurrentRevList).toBeLessThanOrEqual(8);
    expect(behind).toMatchObject(await behindCountsFromGit(repo, branches));
    expect(behind['local-only']).toBeUndefined();
  });

  test('a refresh where no ref moved starts a constant number of git processes', async () => {
    await makeRepoWithBranches();
    const first = await listBehindCounts(repo);
    const firstStats = readSpawnStats();

    const second = await listBehindCounts(repo);
    const secondStats = readSpawnStats();
    expect(secondStats.revList).toBe(0);
    expect(secondStats.total).toBe(firstStats.total - firstStats.revList);
    expect(secondStats.total).toBeLessThanOrEqual(3);
    expect(second).toEqual(first);
  });

  test('after refs move only the changed pairs are recounted and every count matches git', async () => {
    await makeRepoWithBranches();
    await listBehindCounts(repo);

    await advanceOrigin(repo, 'feature-03', 2);
    await advanceOrigin(repo, 'feature-17', 5);
    await advanceOrigin(repo, 'main', 1);
    await advanceOrigin(repo, 'team/fix/item-06', 3);
    await git(repo, 'fetch', 'origin');
    await git(repo, 'branch', '-f', 'feature-30', 'feature-28');

    const behind = await listBehindCounts(repo);
    const stats = readSpawnStats();
    expect(stats.revList).toBe(5);
    const expected = await behindCountsFromGit(repo, branches);
    expect(expected).toMatchObject({
      'feature-03': 2,
      'feature-17': 5,
      main: 1,
      'feature-30': 2,
      'team/fix/item-06': 3,
    });
    expect(behind).toMatchObject(expected);
  });

  test('a count that failed is recounted on the next refresh instead of served from the cache', async () => {
    await makeRepoWithBranches();
    writeFileSync(failRevListFlag, '');
    const failed = await listBehindCounts(repo);
    expect(readSpawnStats().revList).toBe(branches.length);
    expect(failed.main).toBeUndefined();

    rmSync(failRevListFlag);
    const retried = await listBehindCounts(repo);
    expect(readSpawnStats().revList).toBe(branches.length);
    expect(retried).toMatchObject(await behindCountsFromGit(repo, branches));
  });

  test('a window on a linked worktree reuses the counts its repository already has', async () => {
    await makeRepoWithBranches();
    await listBehindCounts(repo);
    const linked = join(root ?? '', 'linked');
    await git(repo, 'worktree', 'add', linked, 'feature-02');

    const behind = await listBehindCounts(linked);
    expect(readSpawnStats().revList).toBe(0);
    expect(behind).toMatchObject(await behindCountsFromGit(repo, branches));
  });
});
