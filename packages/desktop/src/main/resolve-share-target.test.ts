import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RecentProjectEntry } from '@inkeep/open-knowledge-core';
import { resolveShareTarget } from './resolve-share-target.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

interface TempRepoHandle {
  readonly root: string;
  readonly mainRepo: string;
  readonly worktrees: Map<string, string>;
  cleanup(): void;
}

/**
 * Build a temp git repo with a main checkout and N linked worktrees on
 * freshly created branches. Each worktree gets an initial commit so HEAD has
 * a real SHA. Realpath-resolved so macOS `/private/var` symlink collapse
 * doesn't confuse comparisons with the implementation's output.
 */
async function makeRepoWithWorktrees(branches: readonly string[]): Promise<TempRepoHandle> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resolve-share-')));
  const mainRepo = join(root, 'main');
  mkdirSync(mainRepo);
  await git(mainRepo, 'init', '--initial-branch=main', '.');
  await git(mainRepo, 'config', 'user.email', 'test@example.com');
  await git(mainRepo, 'config', 'user.name', 'Test');
  writeFileSync(join(mainRepo, 'README.md'), '# main\n');
  await git(mainRepo, 'add', 'README.md');
  await git(mainRepo, 'commit', '-m', 'initial');

  const worktrees = new Map<string, string>();
  for (const branch of branches) {
    mkdirSync(join(root, 'wt'), { recursive: true });
    const wt = join(root, 'wt', branch.replace(/\//g, '-'));
    await git(mainRepo, 'worktree', 'add', '-b', branch, wt);
    worktrees.set(branch, wt);
  }

  return {
    root,
    mainRepo,
    worktrees,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function recent(path: string): RecentProjectEntry {
  return {
    path,
    name: path.split('/').filter(Boolean).pop() ?? 'project',
    lastOpenedAt: '2026-06-01T00:00:00.000Z',
    gitRemoteUrl: 'https://github.com/acme/widget.git',
  };
}

function seedOkProject(projectPath: string): void {
  mkdirSync(join(projectPath, '.ok'), { recursive: true });
  writeFileSync(join(projectPath, '.ok', 'config.yml'), 'content:\n  dir: .\n');
}

const PAYLOAD = { owner: 'acme', repo: 'widget', branch: 'feat-foo' } as const;

describe('resolveShareTarget — main-side adapter parity with the shared algorithm', () => {
  let handle: TempRepoHandle | null = null;

  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  test('branch-match: a worktree on the shared branch with .ok/config.yml resolves branch-match-ok', async () => {
    handle = await makeRepoWithWorktrees(['feat-foo']);
    const wtPath = handle.worktrees.get('feat-foo');
    expect(wtPath).toBeDefined();
    if (!wtPath) return;
    seedOkProject(wtPath);

    const selection = await resolveShareTarget(PAYLOAD, {
      listRecent: () => [recent(handle?.mainRepo ?? '')],
    });

    expect(selection.kind).toBe('branch-match-ok');
    if (selection.kind === 'branch-match-ok') {
      expect(selection.candidate.path).toBe(wtPath);
      expect(selection.candidate.head.currentBranch).toBe('feat-foo');
      expect(selection.candidate.hasOkConfig).toBe(true);
    }
  });

  test('branch-match non-OK: worktree on the shared branch without .ok/config.yml routes to consent', async () => {
    handle = await makeRepoWithWorktrees(['feat-foo']);
    const wtPath = handle.worktrees.get('feat-foo');
    expect(wtPath).toBeDefined();
    if (!wtPath) return;

    const selection = await resolveShareTarget(PAYLOAD, {
      listRecent: () => [recent(handle?.mainRepo ?? '')],
    });

    expect(selection.kind).toBe('branch-match-non-ok');
    if (selection.kind === 'branch-match-non-ok') {
      expect(selection.candidate.path).toBe(wtPath);
      expect(selection.candidate.hasOkConfig).toBe(false);
    }
  });

  test('branch-mismatch: only a main checkout on a different branch produces fallback main-checkout', async () => {
    handle = await makeRepoWithWorktrees([]);
    seedOkProject(handle.mainRepo);

    const selection = await resolveShareTarget(PAYLOAD, {
      listRecent: () => [recent(handle?.mainRepo ?? '')],
    });

    expect(selection.kind).toBe('fallback');
    if (selection.kind === 'fallback') {
      expect(selection.reason).toBe('main-checkout');
      expect(selection.anchor.path).toBe(handle.mainRepo);
      expect(selection.anchor.head.currentBranch).toBe('main');
    }
  });

  test('miss: no Recents matches the shared repo by gitRemoteUrl', async () => {
    handle = await makeRepoWithWorktrees([]);
    const otherRepoRecent: RecentProjectEntry = {
      path: handle.mainRepo,
      name: 'main',
      lastOpenedAt: '2026-06-01T00:00:00.000Z',
      gitRemoteUrl: 'https://github.com/other/repo.git',
    };

    const selection = await resolveShareTarget(PAYLOAD, {
      listRecent: () => [otherRepoRecent],
    });

    expect(selection).toEqual({ kind: 'miss' });
  });

  test('miss: no Recents at all', async () => {
    handle = await makeRepoWithWorktrees([]);
    const selection = await resolveShareTarget(PAYLOAD, {
      listRecent: () => [],
    });
    expect(selection).toEqual({ kind: 'miss' });
  });

  test('non-OK fallback skipped: branch-mismatch with no OK-initialized candidate falls to miss', async () => {
    handle = await makeRepoWithWorktrees([]);
    const selection = await resolveShareTarget(PAYLOAD, {
      listRecent: () => [recent(handle?.mainRepo ?? '')],
    });
    expect(selection).toEqual({ kind: 'miss' });
  });

  test('parity: real git I/O + real isProjectRoot reproduces the renderer outcome shape for an OK worktree on the shared branch', async () => {
    handle = await makeRepoWithWorktrees(['feat-foo', 'feat-bar']);
    const featFoo = handle.worktrees.get('feat-foo');
    expect(featFoo).toBeDefined();
    if (!featFoo) return;
    seedOkProject(handle.mainRepo);
    seedOkProject(featFoo);

    const selection = await resolveShareTarget(PAYLOAD, {
      listRecent: () => [recent(handle?.mainRepo ?? '')],
    });

    expect(selection.kind).toBe('branch-match-ok');
    if (selection.kind === 'branch-match-ok') {
      expect(selection.candidate.path).toBe(featFoo);
      expect(selection.multiCandidate).toBe(true);
    }
  });
});
