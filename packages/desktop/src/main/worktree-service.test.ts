import { afterEach, describe, expect, test } from 'bun:test';
import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { addOkPathsToGitExclude, getOkArtifactPaths } from '@inkeep/open-knowledge';
import { initContent } from '@inkeep/open-knowledge-server';
import { discoverProject } from './folder-admission.ts';
import { clearRecentGitCache } from './worktree-recents.ts';
import {
  checkoutShareBranchWorktree,
  createWorktree,
  listWorktreeSelector,
} from './worktree-service.ts';
import { seedWorktreeProjectSetup } from './worktree-setup-inherit.ts';

const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null' };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: GIT_ENV });
  return String(stdout);
}

interface Handle {
  readonly root: string;
  readonly mainRepo: string;
  cleanup(): void;
}

/** A clean main repo on `main` with a committed README + `.ok/config.yml` so a
 *  worktree checked out from it carries the OK config (mirrors production). */
async function makeRepo(extraBranches: string[] = []): Promise<Handle> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-svc-test-')));
  const mainRepo = join(root, 'main');
  mkdirSync(mainRepo);
  await git(mainRepo, 'init', '--initial-branch=main', '.');
  await git(mainRepo, 'config', 'user.email', 'test@example.com');
  await git(mainRepo, 'config', 'user.name', 'Test');
  mkdirSync(join(mainRepo, '.ok'));
  writeFileSync(join(mainRepo, '.ok', 'config.yml'), 'version: 1\n');
  writeFileSync(join(mainRepo, 'README.md'), '# main\n');
  await git(mainRepo, 'add', '-A');
  await git(mainRepo, 'commit', '-m', 'initial');
  for (const b of extraBranches) await git(mainRepo, 'branch', b);
  return { root, mainRepo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Add a bare `origin` remote to `mainRepo` and push the given local branches to
 * it, creating `origin/<branch>` remote-tracking refs WITHOUT setting up local
 * upstream tracking (a plain `git push origin <b>` doesn't `-u`). Returns after
 * the refs exist so a later `for-each-ref refs/remotes/` sees them. Real git,
 * no network — the bare repo lives on the same filesystem.
 */
async function addBareRemote(mainRepo: string, pushBranches: string[]): Promise<string> {
  const bare = join(mainRepo, '..', 'origin.git');
  // `--initial-branch=main` so the bare repo's symbolic HEAD points at `main`;
  // a clone of it then checks out a working `main` (git's compiled-in default
  // could otherwise be `master`, leaving a clone with no local `main`).
  await git(mainRepo, 'init', '--bare', '--initial-branch=main', bare);
  await git(mainRepo, 'remote', 'add', 'origin', bare);
  for (const b of pushBranches) await git(mainRepo, 'push', 'origin', b);
  // Refresh remote-tracking refs so `refs/remotes/origin/<b>` exists locally.
  await git(mainRepo, 'fetch', 'origin');
  return bare;
}

/** The root-checkout state the share-checkout leg must never disturb: commit,
 *  current branch, and working-tree status. Remote-tracking refs and FETCH_HEAD
 *  are deliberately NOT captured — a fetch writes those by design, and they are
 *  invisible to the user's working copy. */
interface RepoSnapshot {
  readonly head: string;
  readonly branch: string;
  readonly status: string;
}

async function repoSnapshot(repo: string): Promise<RepoSnapshot> {
  return {
    head: (await git(repo, 'rev-parse', 'HEAD')).trim(),
    branch: (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(),
    status: await git(repo, 'status', '--porcelain'),
  };
}

describe('worktree-service', () => {
  let handle: Handle | null = null;
  afterEach(() => {
    handle?.cleanup();
    handle = null;
    // The recent-git classification memo is process-global and keyed by
    // realpath; clear it between tests so a reused tmpdir path can't serve a
    // stale classification (createWorktree also clears it on a successful add).
    clearRecentGitCache();
  });

  test('listWorktreeSelector returns every branch, flags current + main', async () => {
    handle = await makeRepo(['dev', 'feature-x']);
    const res = await listWorktreeSelector(handle.mainRepo, handle.mainRepo);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.mainRoot).toBe(handle.mainRepo);
    const byBranch = new Map(res.model.entries.map((e) => [e.branch, e]));
    expect(byBranch.get('main')?.isMain).toBe(true);
    expect(byBranch.get('main')?.isCurrent).toBe(true);
    expect(byBranch.get('dev')?.worktreePath).toBeNull();
    expect(byBranch.get('feature-x')?.worktreePath).toBeNull();
  });

  test('createWorktree (existing branch) checks it out under .ok/worktrees/ and carries the OK config', async () => {
    handle = await makeRepo(['dev']);
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'dev',
      createBranch: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    expect(res.path).toBe(join(handle.mainRepo, '.ok', 'worktrees', 'dev'));
    expect(existsSync(join(res.path, 'README.md'))).toBe(true);
    // The worktree carries the committed .ok/config.yml → opens as `managed`.
    expect(existsSync(join(res.path, '.ok', 'config.yml'))).toBe(true);
    // The nested worktree is excluded from the parent's git status.
    const status = await git(handle.mainRepo, 'status', '--porcelain');
    expect(status).not.toContain('.ok/worktrees');
  });

  test('createWorktree (-b) creates a new branch + worktree from HEAD', async () => {
    handle = await makeRepo();
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'brand-new',
      createBranch: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    const branches = await git(handle.mainRepo, 'branch', '--list', 'brand-new');
    expect(branches).toContain('brand-new');
  });

  test('createWorktree returns the existing path (created:false) when the branch already has a worktree', async () => {
    handle = await makeRepo(['dev']);
    const first = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'dev',
      createBranch: false,
    });
    expect(first.ok).toBe(true);
    const second = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'dev',
      createBranch: false,
    });
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) return;
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
  });

  test('createWorktree from inside a linked worktree still anchors under the MAIN root', async () => {
    handle = await makeRepo(['dev', 'other']);
    const dev = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'dev',
      createBranch: false,
    });
    expect(dev.ok).toBe(true);
    if (!dev.ok) return;
    // Now create `other` from inside the `dev` worktree — must land under main root.
    const other = await createWorktree({
      anchorPath: dev.path,
      branch: 'other',
      createBranch: false,
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.path).toBe(join(handle.mainRepo, '.ok', 'worktrees', 'other'));
  });

  test('createWorktree rejects a path-escaping branch name', async () => {
    handle = await makeRepo();
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: '../evil',
      createBranch: false,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('invalid-branch');
  });

  test('listWorktreeSelector on a non-git dir returns no-git', async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wt-svc-nogit-')));
    try {
      const res = await listWorktreeSelector(tmp, tmp);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('no-git');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // the current entry is flagged even when OK opens at a git SUBDIRECTORY
  // (the normal OK case: the content dir is a subtree of the worktree toplevel).
  test('listWorktreeSelector flags isCurrent when the anchor is a subdirectory of the worktree', async () => {
    handle = await makeRepo(['dev']);
    // Create a nested content dir inside the main worktree and anchor there.
    const contentDir = join(handle.mainRepo, 'public', 'ok');
    mkdirSync(contentDir, { recursive: true });
    const res = await listWorktreeSelector(contentDir, contentDir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // mainRoot is the git toplevel, not the content subdir.
    expect(res.model.mainRoot).toBe(handle.mainRepo);
    const main = res.model.entries.find((e) => e.branch === 'main');
    // Without the toplevel resolution this would be false (subdir ≠ toplevel).
    expect(main?.isCurrent).toBe(true);
    expect(res.model.currentBranch).toBe('main');
  });

  // the deepest containing worktree wins when a linked worktree is nested
  // under the main root (OK creates worktrees under `<mainRoot>/.ok/worktrees/`).
  test('listWorktreeSelector prefers the deepest containing worktree for a nested anchor', async () => {
    handle = await makeRepo(['dev']);
    const dev = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'dev',
      createBranch: false,
    });
    expect(dev.ok).toBe(true);
    if (!dev.ok) return;
    // Anchor inside a subdir of the `dev` linked worktree (which itself sits
    // under the main root's `.ok/worktrees/`). The dev worktree is the deeper
    // container, so it — not main — must be flagged current.
    const sub = join(dev.path, 'public', 'ok');
    mkdirSync(sub, { recursive: true });
    const res = await listWorktreeSelector(sub, sub);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byBranch = new Map(res.model.entries.map((e) => [e.branch, e]));
    expect(byBranch.get('dev')?.isCurrent).toBe(true);
    expect(byBranch.get('main')?.isCurrent).toBe(false);
    expect(res.model.currentBranch).toBe('dev');
  });

  // a dash-prefixed branch name (e.g. `--detach`) passes `worktreeRelativeDir`
  // but must NOT be parsed by git as a flag. The `--` end-of-options guard forces
  // git to treat it as a literal ref, which `git check-ref-format` then rejects —
  // so we get a classified failure, never a silently-created detached-HEAD worktree.
  test('createWorktree does not let a dash-prefixed branch inject a git flag (checkout arm)', async () => {
    handle = await makeRepo();
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: '--detach',
      createBranch: false,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // `git worktree add <path> -- --detach` → `fatal: invalid reference: --detach`
    // → the `error` fallthrough. The key assertion is that NO worktree was made.
    expect(res.reason).toBe('error');
    // No detached-HEAD (or any) worktree was created for the dash-prefixed name.
    const list = await git(handle.mainRepo, 'worktree', 'list', '--porcelain');
    expect(list).not.toContain('detached');
    expect(list).not.toContain('.ok/worktrees/--detach');
  });

  // the create arm's trailing baseBranch is also a positional, so a
  // dash-prefixed base must be guarded too (the `-b <branch>` value is safe).
  test('createWorktree guards a dash-prefixed baseBranch in the create arm', async () => {
    handle = await makeRepo();
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'brand-new',
      baseBranch: '--detach',
      createBranch: true,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('error');
    // The branch must not have been created from a mis-parsed flag.
    const branches = await git(handle.mainRepo, 'branch', '--list', 'brand-new');
    expect(branches).not.toContain('brand-new');
  });

  // drive classifyAddError's `branch-exists` branch via a real git failure:
  // `git worktree add -b <existing>` → `fatal: a branch named '<x>' already exists`.
  test('createWorktree classifies a duplicate-branch create as branch-exists', async () => {
    handle = await makeRepo(['dev']);
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'dev',
      createBranch: true,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('branch-exists');
  });

  // drive the `path-exists` branch: pre-populate the target worktree dir so
  // `git worktree add` fails with `fatal: '<path>' already exists`.
  test('createWorktree classifies a pre-existing target dir as path-exists', async () => {
    handle = await makeRepo(['dev']);
    // The target path createWorktree will use for `dev`.
    const target = join(handle.mainRepo, '.ok', 'worktrees', 'dev');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'squatter.txt'), 'in the way\n');
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'dev',
      createBranch: false,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('path-exists');
  });

  // drive the `helper-not-found` branch via a real git failure: a REQUIRED
  // clean/smudge filter whose command doesn't exist anywhere on PATH — the
  // same failure shape a Homebrew git-lfs produces under a packaged app's
  // minimal launchd PATH (the checkout aborts before writing any files).
  test('createWorktree classifies a missing required filter as helper-not-found', async () => {
    handle = await makeRepo();
    const missing = 'ok-test-missing-helper-cmd';
    await git(handle.mainRepo, 'config', 'filter.okbogus.clean', `${missing} clean`);
    await git(handle.mainRepo, 'config', 'filter.okbogus.smudge', `${missing} smudge`);
    await git(handle.mainRepo, 'config', 'filter.okbogus.required', 'true');
    writeFileSync(join(handle.mainRepo, '.gitattributes'), 'data.bin filter=okbogus\n');
    // Commit the attributed file with the filter DISABLED (`-c` outranks the
    // repo config) so the fixture commit itself doesn't need the helper.
    writeFileSync(join(handle.mainRepo, 'data.bin'), 'payload\n');
    await git(
      handle.mainRepo,
      '-c',
      'filter.okbogus.required=false',
      '-c',
      'filter.okbogus.clean=cat',
      'add',
      '-A',
    );
    await git(
      handle.mainRepo,
      '-c',
      'filter.okbogus.required=false',
      '-c',
      'filter.okbogus.clean=cat',
      'commit',
      '-m',
      'add filtered file',
    );
    await git(handle.mainRepo, 'branch', 'filtered');
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'filtered',
      createBranch: false,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('helper-not-found');
    expect(res.helper).toContain(missing);
    expect((res.message ?? '').length).toBeGreaterThan(0);
  });

  // drive the `error` fallthrough with a git failure that matches none of
  // the recognized classifications, and confirm the raw stderr is surfaced.
  test('createWorktree surfaces an unrecognized git failure as error with a message', async () => {
    handle = await makeRepo();
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'does-not-exist-branch',
      createBranch: false,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('error');
    expect(typeof res.message).toBe('string');
    expect((res.message ?? '').length).toBeGreaterThan(0);
  });

  // remote enumeration. `listWorktreeSelector` surfaces `origin/<x>`
  // refs (incl. the ones with a local counterpart, for base options) and
  // excludes the `origin/HEAD` symbolic pointer.
  test('listWorktreeSelector surfaces origin/<x> remote refs and drops origin/HEAD', async () => {
    handle = await makeRepo(['dev', 'feature-x']);
    await addBareRemote(handle.mainRepo, ['main', 'dev', 'feature-x']);
    // `git push` doesn't create origin/HEAD; set it explicitly so the exclusion
    // is actually exercised (production repos cloned from a remote have it).
    await git(handle.mainRepo, 'remote', 'set-head', 'origin', 'main');
    const res = await listWorktreeSelector(handle.mainRepo, handle.mainRepo);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const remotes = res.model.remoteBranches;
    expect(remotes).toContain('origin/main');
    expect(remotes).toContain('origin/dev');
    expect(remotes).toContain('origin/feature-x');
    // The symbolic default-branch pointer is not a branch — must be excluded.
    expect(remotes).not.toContain('origin/HEAD');
    expect(remotes).not.toContain('origin');
  });

  // "N behind origin": a local branch whose upstream has advanced reports
  // the commit count; an up-to-date branch reports 0; a branch with no
  // origin/<x> counterpart reports nothing (undefined ≠ 0).
  test('listWorktreeSelector computes per-branch behind-origin counts (no network)', async () => {
    handle = await makeRepo(['dev']);
    await addBareRemote(handle.mainRepo, ['main', 'dev']);
    // Advance origin/main by two commits made in a scratch clone of the bare
    // repo, then fetch — the local `main` is now 2 behind origin/main.
    const scratch = join(handle.root, 'scratch');
    await git(handle.root, 'clone', join(handle.mainRepo, '..', 'origin.git'), scratch);
    await git(scratch, 'config', 'user.email', 'test@example.com');
    await git(scratch, 'config', 'user.name', 'Test');
    writeFileSync(join(scratch, 'a.txt'), 'a\n');
    await git(scratch, 'add', '-A');
    await git(scratch, 'commit', '-m', 'a');
    writeFileSync(join(scratch, 'b.txt'), 'b\n');
    await git(scratch, 'add', '-A');
    await git(scratch, 'commit', '-m', 'b');
    await git(scratch, 'push', 'origin', 'main');
    await git(handle.mainRepo, 'fetch', 'origin');

    const res = await listWorktreeSelector(handle.mainRepo, handle.mainRepo);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byBranch = new Map(res.model.entries.map((e) => [e.branch, e]));
    expect(byBranch.get('main')?.behind).toBe(2);
    // `dev` never advanced upstream → 0 behind (has an upstream, so it's a real 0).
    expect(byBranch.get('dev')?.behind).toBe(0);
  });

  // a remote-only branch is checked out as a NEW LOCAL
  // TRACKING branch off the explicit remote ref, preserving remote history
  // instead of forking a divergent local branch off stale HEAD.
  test('createWorktree (remoteRef) creates a local tracking branch off origin/<x> with remote content', async () => {
    handle = await makeRepo();
    // Build `feature-x` ONLY on the remote: push it from a scratch clone, then
    // delete the local branch so it exists solely as origin/feature-x.
    await addBareRemote(handle.mainRepo, ['main']);
    const scratch = join(handle.root, 'scratch');
    await git(handle.root, 'clone', join(handle.mainRepo, '..', 'origin.git'), scratch);
    await git(scratch, 'config', 'user.email', 'test@example.com');
    await git(scratch, 'config', 'user.name', 'Test');
    await git(scratch, 'checkout', '-b', 'feature-x');
    writeFileSync(join(scratch, 'remote-only.txt'), 'from remote\n');
    await git(scratch, 'add', '-A');
    await git(scratch, 'commit', '-m', 'remote-only feature');
    await git(scratch, 'push', 'origin', 'feature-x');
    await git(handle.mainRepo, 'fetch', 'origin');

    // Sanity: no local `feature-x` yet, only the remote-tracking ref.
    const localBefore = await git(handle.mainRepo, 'branch', '--list', 'feature-x');
    expect(localBefore.trim()).toBe('');

    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'feature-x',
      remoteRef: 'origin/feature-x',
      createBranch: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    expect(res.path).toBe(join(handle.mainRepo, '.ok', 'worktrees', 'feature-x'));
    // The remote commit's file is present → remote history was preserved, NOT a
    // fresh branch off stale HEAD (which would lack remote-only.txt).
    expect(existsSync(join(res.path, 'remote-only.txt'))).toBe(true);
    // A local `feature-x` now exists and TRACKS origin/feature-x.
    const upstream = await git(
      res.path,
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    );
    expect(upstream.trim()).toBe('origin/feature-x');
  });

  // a new branch based on a REMOTE ref starts from that ref's content but
  // does NOT track it (a feature branch must not inherit the base's upstream).
  test('createWorktree (baseRef, --no-track) bases a new branch on origin/<x> without tracking it', async () => {
    handle = await makeRepo();
    // Advance origin/main so basing on origin/main differs from local HEAD.
    await addBareRemote(handle.mainRepo, ['main']);
    const scratch = join(handle.root, 'scratch');
    await git(handle.root, 'clone', join(handle.mainRepo, '..', 'origin.git'), scratch);
    await git(scratch, 'config', 'user.email', 'test@example.com');
    await git(scratch, 'config', 'user.name', 'Test');
    writeFileSync(join(scratch, 'fresh.txt'), 'fresh from origin\n');
    await git(scratch, 'add', '-A');
    await git(scratch, 'commit', '-m', 'fresh commit on origin/main');
    await git(scratch, 'push', 'origin', 'main');
    await git(handle.mainRepo, 'fetch', 'origin');

    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'my-feature',
      baseRef: 'origin/main',
      createBranch: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The new branch starts from the FRESH origin/main tip (has fresh.txt),
    // proving it based on the remote ref, not stale local main.
    expect(existsSync(join(res.path, 'fresh.txt'))).toBe(true);
    // `--no-track` → the feature branch has NO upstream configured.
    let upstreamErr = '';
    try {
      await git(res.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
    } catch (e) {
      upstreamErr = String((e as { stderr?: string }).stderr ?? e);
    }
    // git errors ("no upstream configured") when @{upstream} is unset.
    expect(upstreamErr).not.toBe('');
    const branchList = await git(handle.mainRepo, 'branch', '--list', 'my-feature');
    expect(branchList).toContain('my-feature');
  });

  // a dash-prefixed remoteRef must not inject a git flag. `origin/<x>`
  // resolved refs are never dash-prefixed in practice, but guard the arm anyway.
  test('createWorktree (remoteRef) rejects a path-escaping branch name before spawning git', async () => {
    handle = await makeRepo();
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: '../evil',
      remoteRef: 'origin/evil',
      createBranch: true,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('invalid-branch');
  });
});

// ---------------------------------------------------------------------------
// Share-receive checkout — branch resolution (local ref → remote-tracking ref
// → bounded fetch) + failure classes, all against real git with a bare origin
// on the same filesystem. Every test also pins the feature's headline promise:
// the receiver's main repo (HEAD, current branch, working-tree status) is
// never touched, whichever resolution mode ran.
// ---------------------------------------------------------------------------

describe('worktree-service — share-branch checkout', () => {
  let handle: Handle | null = null;
  afterEach(() => {
    handle?.cleanup();
    handle = null;
    clearRecentGitCache();
  });

  // local-ref mode: an existing local branch is checked out into its worktree
  // WITHOUT any fetch — makeRepo configures no remote at all, so an attempted
  // fetch would fail the create — and the main repo's HEAD, current branch,
  // and dirty state stay untouched.
  test('checkoutShareBranchWorktree (local ref) checks out into a worktree, main repo untouched', async () => {
    handle = await makeRepo(['share-me']);
    // Uncommitted work in the receiver's main repo — the state the worktree leg
    // must never disturb.
    writeFileSync(join(handle.mainRepo, 'wip.txt'), 'uncommitted work\n');
    const headBefore = (await git(handle.mainRepo, 'rev-parse', 'HEAD')).trim();
    const statusBefore = await git(handle.mainRepo, 'status', '--porcelain');
    expect(statusBefore).toContain('wip.txt');

    const res = await checkoutShareBranchWorktree({
      anchorPath: handle.mainRepo,
      branch: 'share-me',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    expect(res.path).toBe(join(handle.mainRepo, '.ok', 'worktrees', 'share-me'));
    const wtBranch = await git(res.path, 'rev-parse', '--abbrev-ref', 'HEAD');
    expect(wtBranch.trim()).toBe('share-me');

    expect((await git(handle.mainRepo, 'rev-parse', 'HEAD')).trim()).toBe(headBefore);
    expect((await git(handle.mainRepo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main');
    expect(await git(handle.mainRepo, 'status', '--porcelain')).toBe(statusBefore);
  });

  // remote-tracking-only mode: no local ref, but origin/<b> is known from an
  // earlier fetch. The remote URL is broken AFTER setup, so if this mode
  // wrongly reached for the network the create would fail — success proves the
  // resolution used the existing remote-tracking ref alone.
  test('checkoutShareBranchWorktree (remote-tracking only) creates a tracking worktree without fetching', async () => {
    handle = await makeRepo(['remote-only']);
    await addBareRemote(handle.mainRepo, ['main', 'remote-only']);
    await git(handle.mainRepo, 'branch', '-D', 'remote-only');
    await git(handle.mainRepo, 'remote', 'set-url', 'origin', join(handle.root, 'gone.git'));
    // Sanity: only the remote-tracking ref remains.
    expect((await git(handle.mainRepo, 'branch', '--list', 'remote-only')).trim()).toBe('');
    expect(
      (await git(handle.mainRepo, 'branch', '-r', '--list', 'origin/remote-only')).trim(),
    ).not.toBe('');
    writeFileSync(join(handle.mainRepo, 'wip.txt'), 'uncommitted work\n');
    const before = await repoSnapshot(handle.mainRepo);

    const res = await checkoutShareBranchWorktree({
      anchorPath: handle.mainRepo,
      branch: 'remote-only',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    expect(res.path).toBe(join(handle.mainRepo, '.ok', 'worktrees', 'remote-only'));
    expect((await git(res.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('remote-only');
    // The new local branch tracks the remote ref it was cut from.
    const upstream = await git(
      res.path,
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    );
    expect(upstream.trim()).toBe('origin/remote-only');
    expect(await repoSnapshot(handle.mainRepo)).toEqual(before);
  });

  // never-fetched mode: the branch exists ONLY on the bare origin (pushed from
  // a scratch clone after the main repo's last fetch), so resolution must
  // fetch first. The default fetch refspec materializes the remote-tracking
  // ref, and the worktree's new local branch tracks it.
  test('checkoutShareBranchWorktree (never fetched) fetches the branch and creates a tracking worktree', async () => {
    handle = await makeRepo();
    await addBareRemote(handle.mainRepo, ['main']);
    const scratch = join(handle.root, 'scratch');
    await git(handle.root, 'clone', join(handle.mainRepo, '..', 'origin.git'), scratch);
    await git(scratch, 'config', 'user.email', 'test@example.com');
    await git(scratch, 'config', 'user.name', 'Test');
    await git(scratch, 'checkout', '-b', 'never-fetched');
    writeFileSync(join(scratch, 'remote-only.txt'), 'from remote\n');
    await git(scratch, 'add', '-A');
    await git(scratch, 'commit', '-m', 'remote-only commit');
    await git(scratch, 'push', 'origin', 'never-fetched');
    // Sanity: the main repo knows nothing of the branch — no local ref and no
    // remote-tracking ref.
    expect((await git(handle.mainRepo, 'branch', '--list', 'never-fetched')).trim()).toBe('');
    expect(
      (await git(handle.mainRepo, 'branch', '-r', '--list', 'origin/never-fetched')).trim(),
    ).toBe('');
    writeFileSync(join(handle.mainRepo, 'wip.txt'), 'uncommitted work\n');
    const before = await repoSnapshot(handle.mainRepo);

    const res = await checkoutShareBranchWorktree({
      anchorPath: handle.mainRepo,
      branch: 'never-fetched',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    expect(res.path).toBe(join(handle.mainRepo, '.ok', 'worktrees', 'never-fetched'));
    // The worktree holds the remote commit's content — the fetch actually ran.
    expect(existsSync(join(res.path, 'remote-only.txt'))).toBe(true);
    // The fetch materialized the remote-tracking ref; the local branch tracks it.
    expect(
      (await git(handle.mainRepo, 'branch', '-r', '--list', 'origin/never-fetched')).trim(),
    ).not.toBe('');
    const upstream = await git(
      res.path,
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    );
    expect(upstream.trim()).toBe('origin/never-fetched');
    expect(await repoSnapshot(handle.mainRepo)).toEqual(before);
  });

  // create-or-locate: a second share for the same branch must find the first
  // share's worktree, not attempt a duplicate.
  test('checkoutShareBranchWorktree (second share, same branch) returns the existing worktree with created:false', async () => {
    handle = await makeRepo(['share-me']);
    writeFileSync(join(handle.mainRepo, 'wip.txt'), 'uncommitted work\n');
    const first = await checkoutShareBranchWorktree({
      anchorPath: handle.mainRepo,
      branch: 'share-me',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    const before = await repoSnapshot(handle.mainRepo);

    const second = await checkoutShareBranchWorktree({
      anchorPath: handle.mainRepo,
      branch: 'share-me',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    expect(await repoSnapshot(handle.mainRepo)).toEqual(before);
  });

  // fetch-leg failure, terminal class: the branch never existed on origin, so
  // git reports "couldn't find remote ref" and the checkout returns the
  // terminal branch-not-found — with nothing created locally.
  test('checkoutShareBranchWorktree classifies a branch absent from origin as branch-not-found', async () => {
    handle = await makeRepo();
    await addBareRemote(handle.mainRepo, ['main']);
    writeFileSync(join(handle.mainRepo, 'wip.txt'), 'uncommitted work\n');
    const before = await repoSnapshot(handle.mainRepo);

    const res = await checkoutShareBranchWorktree({
      anchorPath: handle.mainRepo,
      branch: 'ghost',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('branch-not-found');
    // The failed resolution created nothing: no worktree dir, no local branch.
    expect(existsSync(join(handle.mainRepo, '.ok', 'worktrees', 'ghost'))).toBe(false);
    expect((await git(handle.mainRepo, 'branch', '--list', 'ghost')).trim()).toBe('');
    expect(await repoSnapshot(handle.mainRepo)).toEqual(before);
  });

  // fetch-leg failure, retryable class: origin's URL points at a path that
  // doesn't exist (a network-down stand-in), so the fetch fails without
  // matching the branch-gone discriminator, and the stderr is surfaced for
  // diagnostics.
  test('checkoutShareBranchWorktree classifies an unreachable origin as fetch-failed', async () => {
    handle = await makeRepo();
    await git(handle.mainRepo, 'remote', 'add', 'origin', join(handle.root, 'missing.git'));
    writeFileSync(join(handle.mainRepo, 'wip.txt'), 'uncommitted work\n');
    const before = await repoSnapshot(handle.mainRepo);

    const res = await checkoutShareBranchWorktree({
      anchorPath: handle.mainRepo,
      branch: 'any-branch',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('fetch-failed');
    expect(typeof res.message).toBe('string');
    expect((res.message ?? '').length).toBeGreaterThan(0);
    expect(existsSync(join(handle.mainRepo, '.ok', 'worktrees', 'any-branch'))).toBe(false);
    expect(await repoSnapshot(handle.mainRepo)).toEqual(before);
  });

  // fetch-leg hang: an ext:: transport that just sleeps stands in for a
  // stalled network. The injected bound must kill the fetch (classified
  // retryable) long before the transport would give up on its own. The elapsed
  // LOWER bound proves the transport genuinely hung — an instant transport
  // failure would classify identically but wouldn't exercise the kill. The
  // orphaned sleep self-expires without holding the test process open.
  test('checkoutShareBranchWorktree kills a hanging fetch at the injected timeout (fetch-failed)', async () => {
    handle = await makeRepo();
    // ext:: transports are disallowed by default on modern git; opt in via
    // repo config so the service's plain `git fetch` spawn (no -c flags)
    // honors it. git-remote-ext splits the address on spaces with no shell,
    // so `ext::sleep 60` runs `sleep` with argument `60`.
    await git(handle.mainRepo, 'config', 'protocol.ext.allow', 'always');
    await git(handle.mainRepo, 'remote', 'add', 'origin', 'ext::sleep 60');
    writeFileSync(join(handle.mainRepo, 'wip.txt'), 'uncommitted work\n');
    const before = await repoSnapshot(handle.mainRepo);

    const t0 = Date.now();
    const res = await checkoutShareBranchWorktree({
      anchorPath: handle.mainRepo,
      branch: 'any-branch',
      fetchTimeoutMs: 500,
    });
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('fetch-failed');
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(10_000);
    expect(await repoSnapshot(handle.mainRepo)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Inherited OK setup — the worktree opens `managed` (no consent dialog), with
// full parity, for both shared and local-only roots. Real git throughout: the
// classification is checked through the actual admission path (`discoverProject`
// → `isProjectRoot`), not a mock.
// ---------------------------------------------------------------------------

/** True iff `path` is git-ignored inside `cwd` (check-ignore exits 0). */
async function isIgnored(cwd: string, path: string): Promise<boolean> {
  try {
    await git(cwd, 'check-ignore', '-q', '--', path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A local-only OK repo: `.ok/config.yml` (+ editor MCP wiring) exists at the
 * main root but is NEVER committed — it's excluded via the shared common-dir
 * `.git/info/exclude`, exactly as `addOkPathsToGitExclude` does for a
 * local-only project. Only README is committed, so a worktree checked out from
 * `main` does NOT carry `.ok/config.yml`.
 */
async function makeLocalOnlyRepo(): Promise<Handle> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-svc-local-')));
  const mainRepo = join(root, 'main');
  mkdirSync(mainRepo);
  await git(mainRepo, 'init', '--initial-branch=main', '.');
  await git(mainRepo, 'config', 'user.email', 'test@example.com');
  await git(mainRepo, 'config', 'user.name', 'Test');
  writeFileSync(join(mainRepo, 'README.md'), '# main\n');
  await git(mainRepo, 'add', '-A');
  await git(mainRepo, 'commit', '-m', 'initial');
  // Scaffold the OK project + a claude wiring at the root, then go local-only.
  initContent(mainRepo, { contentDir: 'docs' });
  mkdirSync(join(mainRepo, '.ok'), { recursive: true });
  // A claude project MCP config carrying the OK sentinel (never committed).
  writeFileSync(
    join(mainRepo, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'open-knowledge': { command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v1\nexec ok mcp'] },
      },
    }),
  );
  const excl = addOkPathsToGitExclude(mainRepo, getOkArtifactPaths(mainRepo));
  if (excl.kind !== 'updated') throw new Error(`expected local-only exclude, got ${excl.kind}`);
  return { root, mainRepo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('worktree-service — inherited OK setup (no consent dialog)', () => {
  let handle: Handle | null = null;
  afterEach(() => {
    handle?.cleanup();
    handle = null;
    clearRecentGitCache();
  });

  test('HARD GATE: seeding flips a local-only worktree from `fresh` (dialog) to `managed` (silent)', async () => {
    handle = await makeLocalOnlyRepo();
    const wtPath = join(handle.root, 'flip-wt');
    // Manual `git worktree add` — un-seeded, so we can observe the classification
    // BEFORE and AFTER seeding (createWorktree would auto-seed).
    execFileSync('git', ['worktree', 'add', '-b', 'flip', wtPath, 'main'], {
      cwd: handle.mainRepo,
      env: GIT_ENV,
    });
    // Branch `main` never committed `.ok/`, so the worktree has no config.yml.
    expect(existsSync(join(wtPath, '.ok', 'config.yml'))).toBe(false);

    // BEFORE: the linked-worktree carveout classifies it `fresh` → consent dialog.
    const before = await discoverProject(wtPath, { homeDir: handle.root, dirSizeProbe: null });
    expect(before.kind).toBe('fresh');

    seedWorktreeProjectSetup(wtPath, handle.mainRepo);

    // AFTER: a real, parseable config.yml now marks the worktree a project root,
    // so discovery classifies it `managed` — the consent dialog is suppressed.
    expect(existsSync(join(wtPath, '.ok', 'config.yml'))).toBe(true);
    const after = await discoverProject(wtPath, { homeDir: handle.root, dirSizeProbe: null });
    expect(after.kind).toBe('managed');
    if (after.kind !== 'managed') return;
    expect(after.projectDir).toBe(wtPath);
    expect(after.ancestorPromoted).toBe(false);
  });

  test('local-only root: the seeded config.yml (+ editor wiring) stays UNTRACKED in the worktree', async () => {
    handle = await makeLocalOnlyRepo();
    const wtPath = join(handle.root, 'local-wt');
    execFileSync('git', ['worktree', 'add', '-b', 'local-branch', wtPath, 'main'], {
      cwd: handle.mainRepo,
      env: GIT_ENV,
    });

    seedWorktreeProjectSetup(wtPath, handle.mainRepo);

    // Root wired claude → the worktree gets `.mcp.json`, adapted (byte-identical
    // resilient chain) under the worktree path.
    expect(existsSync(join(wtPath, '.mcp.json'))).toBe(true);
    // content.dir was inherited from the root.
    expect(readFileSync(join(wtPath, '.ok', 'config.yml'), 'utf-8')).toContain('dir: docs');

    // The shared common-dir exclude covers the worktree's copies → ignored,
    // hence UNTRACKED. The seed never stages anything.
    expect(await isIgnored(wtPath, '.ok/config.yml')).toBe(true);
    expect(await isIgnored(wtPath, '.mcp.json')).toBe(true);
    const status = await git(wtPath, 'status', '--porcelain');
    expect(status).not.toContain('.ok/config.yml');
    expect(status).not.toContain('.mcp.json');
  });

  test('shared root (config committed): createWorktree opens managed and never clobbers the committed config', async () => {
    // makeRepo commits `.ok/config.yml` as `version: 1\n` (shared posture).
    handle = await makeRepo();
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'shared-wt',
      createBranch: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Seed is writeIfMissing → the committed config is preserved byte-for-byte.
    expect(readFileSync(join(res.path, '.ok', 'config.yml'), 'utf-8')).toBe('version: 1\n');

    const disc = await discoverProject(res.path, { homeDir: handle.root, dirSizeProbe: null });
    expect(disc.kind).toBe('managed');
    if (disc.kind !== 'managed') return;
    expect(disc.projectDir).toBe(res.path);
  });
});
