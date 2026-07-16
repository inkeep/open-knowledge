import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RecentProjectEntry } from '@inkeep/open-knowledge-core';
import { filterShareEligibleRecents, resolveShareTarget } from './resolve-share-target.ts';
import { annotateMissing, emptyState } from './state-store.ts';

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

  test('a ghost most-recent entry does not poison the worktree-enumeration anchor', async () => {
    // The behavior only the recents filter provides: it runs upstream of
    // findRecentProjectsForRepo, so it is what keeps the ghost from becoming
    // recentMatches[0] and rooting listGitWorktrees at a non-repo cwd. Drop
    // the filter and this share lands on `fallback`/main-checkout — a
    // branch-switch dialog — even though the branch is already checked out in
    // a worktree. The downstream soft-match guard runs after the anchor is
    // chosen and cannot rescue this.
    handle = await makeRepoWithWorktrees(['feat-foo']);
    const wtPath = handle.worktrees.get('feat-foo');
    expect(wtPath).toBeDefined();
    if (!wtPath) return;
    seedOkProject(handle.mainRepo);
    seedOkProject(wtPath);

    const ghostPath = join(handle.root, 'CollaborationUX');
    mkdirSync(join(ghostPath, '.ok', 'local', 'logs'), { recursive: true });
    writeFileSync(join(ghostPath, '.ok', 'local', 'logs', 'server-current.jsonl'), '{}\n');

    const selection = await resolveShareTarget(PAYLOAD, {
      // Ghost is the most recently opened, so it would be the anchor.
      listRecent: () => [recent(ghostPath), recent(handle?.mainRepo ?? '')],
    });

    expect(selection.kind).toBe('branch-match-ok');
    if (selection.kind === 'branch-match-ok') {
      expect(selection.candidate.path).toBe(wtPath);
    }
  });

  test('filterShareEligibleRecents drops a ghost directory (no .git) but keeps a real git working tree', async () => {
    // The share-admission predicate must refuse a moved-away directory that
    // survives the bare-existence missing filter — it exists on disk but holds
    // only OK's own droppings (no .git, no .ok/config.yml) — while still
    // admitting a real checkout. Uses the real on-disk readGitDirKind against
    // real fixtures.
    handle = await makeRepoWithWorktrees([]);
    const ghostRoot = realpathSync(mkdtempSync(join(tmpdir(), 'eligible-ghost-')));
    try {
      const ghostPath = join(ghostRoot, 'CollaborationUX');
      mkdirSync(join(ghostPath, '.ok', 'local', 'logs'), { recursive: true });
      writeFileSync(join(ghostPath, '.ok', 'local', 'logs', 'server-current.jsonl'), '{}\n');

      const ghostEntry = recent(ghostPath);
      const liveEntry = recent(handle.mainRepo);

      const eligible = filterShareEligibleRecents([ghostEntry, liveEntry]);

      expect(eligible.map((e) => e.path)).toEqual([handle.mainRepo]);
    } finally {
      rmSync(ghostRoot, { recursive: true, force: true });
    }
  });

  test('filterShareEligibleRecents drops a stale worktree pointer (.git file to a gone gitdir)', async () => {
    // The moved-away-linked-worktree ghost shape: the directory still holds a
    // `.git` FILE, but its pointer targets an admin gitdir that no longer
    // exists. Not a dispatchable checkout — must be refused like the
    // no-.git ghost.
    handle = await makeRepoWithWorktrees([]);
    const staleRoot = realpathSync(mkdtempSync(join(tmpdir(), 'eligible-stale-')));
    try {
      const stalePath = join(staleRoot, 'CollaborationUX');
      mkdirSync(stalePath, { recursive: true });
      writeFileSync(
        join(stalePath, '.git'),
        `gitdir: ${join(staleRoot, 'gone', '.git', 'worktrees', 'x')}\n`,
      );

      const staleEntry = recent(stalePath);
      const liveEntry = recent(handle.mainRepo);

      const eligible = filterShareEligibleRecents([staleEntry, liveEntry]);

      expect(eligible.map((e) => e.path)).toEqual([handle.mainRepo]);
    } finally {
      rmSync(staleRoot, { recursive: true, force: true });
    }
  });

  test('ghost recents entry (exists, no .git, no .ok/config.yml) resolves to miss through the production annotateMissing wiring', async () => {
    // Reproduces the full share-receive ghost scenario end to end: a recents
    // entry still carries the repo's gitRemoteUrl from when the project was
    // real at this path, but the path now holds only OK's own droppings (the
    // folder was moved in Finder and the still-running server recreated it to
    // write logs). The share carries a branch. A ghost directory that is
    // neither a git checkout nor an OK project must never be presented as the
    // share target with a "this branch is checked out here" claim — selection
    // must return a miss.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'resolve-share-ghost-')));
    handle = {
      root,
      mainRepo: root,
      worktrees: new Map(),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
    const ghostPath = join(root, 'CollaborationUX');
    mkdirSync(join(ghostPath, '.ok', 'local', 'logs'), { recursive: true });
    writeFileSync(join(ghostPath, '.ok', 'local', 'logs', 'server-current.jsonl'), '{}\n');

    const state = {
      ...emptyState(),
      recentProjects: [
        {
          path: ghostPath,
          name: 'CollaborationUX',
          lastOpenedAt: '2026-07-15T00:00:00.000Z',
          gitRemoteUrl: 'https://github.com/acme/widget.git',
        },
      ],
    };

    const selection = await resolveShareTarget(PAYLOAD, {
      // Production wiring: the share path feeds selection the annotateMissing
      // projection, which marks this ghost non-missing because the directory
      // does exist — so it reaches the share-eligibility filter rather than
      // being dropped upstream of it.
      listRecent: () => annotateMissing(state),
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
