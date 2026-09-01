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
import { afterEach, describe, expect, test } from 'vitest';
import { discoverProject } from './folder-admission.ts';
import { clearRecentGitCache } from './worktree-recents.ts';
import {
  buildShareFetchArgs,
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

async function addBareRemote(mainRepo: string, pushBranches: string[]): Promise<string> {
  const bare = join(mainRepo, '..', 'origin.git');
  await git(mainRepo, 'init', '--bare', '--initial-branch=main', bare);
  await git(mainRepo, 'remote', 'add', 'origin', bare);
  for (const b of pushBranches) await git(mainRepo, 'push', 'origin', b);
  await git(mainRepo, 'fetch', 'origin');
  return bare;
}

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
    expect(existsSync(join(res.path, '.ok', 'config.yml'))).toBe(true);
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

  test('createWorktree reports empty-repo (not the generic arm) on a repo with no commits', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-svc-empty-')));
    try {
      await git(root, 'init', '--initial-branch=main', '.');
      const res = await createWorktree({
        anchorPath: root,
        branch: 'wt-1',
        createBranch: true,
        baseBranch: 'main',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('empty-repo');
      expect(res.message).toMatch(/invalid reference|not a valid object name/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('createWorktree still reports the generic arm when the repo HAS commits', async () => {
    handle = await makeRepo();
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'wt-1',
      createBranch: true,
      baseBranch: 'no-such-base',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).not.toBe('empty-repo');
  });

  test('a repo with history on another branch is not called empty when the base is unborn', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-svc-other-branch-')));
    try {
      await git(root, 'init', '--initial-branch=other', '.');
      await git(root, 'config', 'user.email', 'test@example.com');
      await git(root, 'config', 'user.name', 'Test');
      await git(root, 'commit', '--allow-empty', '-m', 'real history');
      await git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main');

      const res = await createWorktree({
        anchorPath: root,
        branch: 'wt-1',
        createBranch: true,
        baseBranch: 'main',
      });

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).not.toBe('empty-repo');
      expect(res.message).toMatch(/invalid reference|not a valid object name/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test('listWorktreeSelector flags isCurrent when the anchor is a subdirectory of the worktree', async () => {
    handle = await makeRepo(['dev']);
    const contentDir = join(handle.mainRepo, 'public', 'ok');
    mkdirSync(contentDir, { recursive: true });
    const res = await listWorktreeSelector(contentDir, contentDir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.mainRoot).toBe(handle.mainRepo);
    const main = res.model.entries.find((e) => e.branch === 'main');
    expect(main?.isCurrent).toBe(true);
    expect(res.model.currentBranch).toBe('main');
  });

  test('listWorktreeSelector prefers the deepest containing worktree for a nested anchor', async () => {
    handle = await makeRepo(['dev']);
    const dev = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'dev',
      createBranch: false,
    });
    expect(dev.ok).toBe(true);
    if (!dev.ok) return;
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

  test('createWorktree does not let a dash-prefixed branch inject a git flag (checkout arm)', async () => {
    handle = await makeRepo();
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: '--detach',
      createBranch: false,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('error');
    const list = await git(handle.mainRepo, 'worktree', 'list', '--porcelain');
    expect(list).not.toContain('detached');
    expect(list).not.toContain('.ok/worktrees/--detach');
  });

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
    const branches = await git(handle.mainRepo, 'branch', '--list', 'brand-new');
    expect(branches).not.toContain('brand-new');
  });

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

  test('createWorktree classifies a pre-existing target dir as path-exists', async () => {
    handle = await makeRepo(['dev']);
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

  test('createWorktree classifies a missing required filter as helper-not-found', async () => {
    handle = await makeRepo();
    const missing = 'ok-test-missing-helper-cmd';
    await git(handle.mainRepo, 'config', 'filter.okbogus.clean', `${missing} clean`);
    await git(handle.mainRepo, 'config', 'filter.okbogus.smudge', `${missing} smudge`);
    await git(handle.mainRepo, 'config', 'filter.okbogus.required', 'true');
    writeFileSync(join(handle.mainRepo, '.gitattributes'), 'data.bin filter=okbogus\n');
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

  test('listWorktreeSelector surfaces origin/<x> remote refs and drops origin/HEAD', async () => {
    handle = await makeRepo(['dev', 'feature-x']);
    await addBareRemote(handle.mainRepo, ['main', 'dev', 'feature-x']);
    await git(handle.mainRepo, 'remote', 'set-head', 'origin', 'main');
    const res = await listWorktreeSelector(handle.mainRepo, handle.mainRepo);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const remotes = res.model.remoteBranches;
    expect(remotes).toContain('origin/main');
    expect(remotes).toContain('origin/dev');
    expect(remotes).toContain('origin/feature-x');
    expect(remotes).not.toContain('origin/HEAD');
    expect(remotes).not.toContain('origin');
  });

  test('listWorktreeSelector computes per-branch behind-origin counts (no network)', async () => {
    handle = await makeRepo(['dev']);
    await addBareRemote(handle.mainRepo, ['main', 'dev']);
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
    expect(byBranch.get('dev')?.behind).toBe(0);
  });

  test('createWorktree (remoteRef) creates a local tracking branch off origin/<x> with remote content', async () => {
    handle = await makeRepo();
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
    expect(existsSync(join(res.path, 'remote-only.txt'))).toBe(true);
    const upstream = await git(
      res.path,
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    );
    expect(upstream.trim()).toBe('origin/feature-x');
  });

  test('createWorktree (baseRef, --no-track) bases a new branch on origin/<x> without tracking it', async () => {
    handle = await makeRepo();
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
    expect(existsSync(join(res.path, 'fresh.txt'))).toBe(true);
    let upstreamErr = '';
    try {
      await git(res.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
    } catch (e) {
      upstreamErr = String((e as { stderr?: string }).stderr ?? e);
    }
    expect(upstreamErr).not.toBe('');
    const branchList = await git(handle.mainRepo, 'branch', '--list', 'my-feature');
    expect(branchList).toContain('my-feature');
  });

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

describe('worktree-service — share-branch checkout', () => {
  let handle: Handle | null = null;
  afterEach(() => {
    handle?.cleanup();
    handle = null;
    clearRecentGitCache();
  });

  test('checkoutShareBranchWorktree (local ref) checks out into a worktree, main repo untouched', async () => {
    handle = await makeRepo(['share-me']);
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

  test('checkoutShareBranchWorktree (remote-tracking only) creates a tracking worktree without fetching', async () => {
    handle = await makeRepo(['remote-only']);
    await addBareRemote(handle.mainRepo, ['main', 'remote-only']);
    await git(handle.mainRepo, 'branch', '-D', 'remote-only');
    await git(handle.mainRepo, 'remote', 'set-url', 'origin', join(handle.root, 'gone.git'));
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
    expect(existsSync(join(res.path, 'remote-only.txt'))).toBe(true);
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

  test('share fetch pins credential interactivity off so no helper can open a dialog', () => {
    const args = buildShareFetchArgs('feat-x');
    expect(args).toEqual(['-c', 'credential.interactive=false', 'fetch', 'origin', 'feat-x']);
    expect(args.indexOf('-c')).toBeLessThan(args.indexOf('fetch'));
  });

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
    expect(existsSync(join(handle.mainRepo, '.ok', 'worktrees', 'ghost'))).toBe(false);
    expect((await git(handle.mainRepo, 'branch', '--list', 'ghost')).trim()).toBe('');
    expect(await repoSnapshot(handle.mainRepo)).toEqual(before);
  });

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
    expect(res.authFailed).toBeUndefined();
    expect(existsSync(join(handle.mainRepo, '.ok', 'worktrees', 'any-branch'))).toBe(false);
    expect(await repoSnapshot(handle.mainRepo)).toEqual(before);
  });

  test('checkoutShareBranchWorktree flags a credential miss as authFailed', async () => {
    handle = await makeRepo();
    const faultyRemote = join(handle.root, 'no-cred-remote.sh');
    writeFileSync(
      faultyRemote,
      '#!/bin/sh\necho "fatal: could not read Username for \'https://github.com\': terminal prompts disabled" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    await git(handle.mainRepo, 'config', 'protocol.ext.allow', 'always');
    await git(handle.mainRepo, 'remote', 'add', 'origin', `ext::${faultyRemote}`);
    const before = await repoSnapshot(handle.mainRepo);

    const res = await checkoutShareBranchWorktree({
      anchorPath: handle.mainRepo,
      branch: 'any-branch',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('fetch-failed');
    expect(res.authFailed).toBe(true);
    expect(existsSync(join(handle.mainRepo, '.ok', 'worktrees', 'any-branch'))).toBe(false);
    expect(await repoSnapshot(handle.mainRepo)).toEqual(before);
  });

  test('checkoutShareBranchWorktree does not flag repository-not-found as authFailed', async () => {
    handle = await makeRepo();
    const notFoundRemote = join(handle.root, 'not-found-remote.sh');
    writeFileSync(
      notFoundRemote,
      '#!/bin/sh\necho "remote: Repository not found." >&2\necho "fatal: repository \'https://github.com/acme/gone.git/\' not found" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    await git(handle.mainRepo, 'config', 'protocol.ext.allow', 'always');
    await git(handle.mainRepo, 'remote', 'add', 'origin', `ext::${notFoundRemote}`);

    const res = await checkoutShareBranchWorktree({
      anchorPath: handle.mainRepo,
      branch: 'any-branch',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('fetch-failed');
    expect(res.authFailed).toBeUndefined();
    expect(res.notFoundAsIdentity).toBe(true);
    expect(res.message).toMatch(/not found/i);
  });

  test('checkoutShareBranchWorktree kills a hanging fetch at the injected timeout (fetch-failed)', async () => {
    handle = await makeRepo();
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

async function isIgnored(cwd: string, path: string): Promise<boolean> {
  try {
    await git(cwd, 'check-ignore', '-q', '--', path);
    return true;
  } catch {
    return false;
  }
}

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
  initContent(mainRepo, { contentDir: 'docs' });
  mkdirSync(join(mainRepo, '.ok'), { recursive: true });
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
    execFileSync('git', ['worktree', 'add', '-b', 'flip', wtPath, 'main'], {
      cwd: handle.mainRepo,
      env: GIT_ENV,
    });
    expect(existsSync(join(wtPath, '.ok', 'config.yml'))).toBe(false);

    const before = await discoverProject(wtPath, { homeDir: handle.root, dirSizeProbe: null });
    expect(before.kind).toBe('fresh');

    seedWorktreeProjectSetup(wtPath, handle.mainRepo);

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

    expect(existsSync(join(wtPath, '.mcp.json'))).toBe(true);
    expect(readFileSync(join(wtPath, '.ok', 'config.yml'), 'utf-8')).toContain('dir: docs');

    expect(await isIgnored(wtPath, '.ok/config.yml')).toBe(true);
    expect(await isIgnored(wtPath, '.mcp.json')).toBe(true);
    const status = await git(wtPath, 'status', '--porcelain');
    expect(status).not.toContain('.ok/config.yml');
    expect(status).not.toContain('.mcp.json');
  });

  test('shared root (config committed): createWorktree opens managed and never clobbers the committed config', async () => {
    handle = await makeRepo();
    const res = await createWorktree({
      anchorPath: handle.mainRepo,
      branch: 'shared-wt',
      createBranch: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(readFileSync(join(res.path, '.ok', 'config.yml'), 'utf-8')).toBe('version: 1\n');

    const disc = await discoverProject(res.path, { homeDir: handle.root, dirSizeProbe: null });
    expect(disc.kind).toBe('managed');
    if (disc.kind !== 'managed') return;
    expect(disc.projectDir).toBe(res.path);
  });
});
