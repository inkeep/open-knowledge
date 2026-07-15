import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  branchExistsOnOrigin,
  originGitHubHost,
  readGitHeadBranch,
  readOriginGitHubRepo,
  readSyncRemoteInfo,
} from './git-context.ts';

function seedRepo(
  root: string,
  spec: {
    head?: string;
    config?: string;
    branchRefs?: Record<string, string>;
    packedRefs?: string;
    gitDirAsFile?: { contents: string };
  } = {},
): void {
  if (spec.gitDirAsFile) {
    writeFileSync(join(root, '.git'), spec.gitDirAsFile.contents, 'utf-8');
    return;
  }
  const gitDir = join(root, '.git');
  mkdirSync(gitDir, { recursive: true });
  if (spec.head !== undefined) {
    writeFileSync(join(gitDir, 'HEAD'), spec.head, 'utf-8');
  }
  if (spec.config !== undefined) {
    writeFileSync(join(gitDir, 'config'), spec.config, 'utf-8');
  }
  if (spec.branchRefs) {
    const refDir = join(gitDir, 'refs', 'remotes', 'origin');
    mkdirSync(refDir, { recursive: true });
    for (const [branch, sha] of Object.entries(spec.branchRefs)) {
      const refPath = join(refDir, branch);
      mkdirSync(resolve(refPath, '..'), { recursive: true });
      writeFileSync(refPath, sha, 'utf-8');
    }
  }
  if (spec.packedRefs !== undefined) {
    writeFileSync(join(gitDir, 'packed-refs'), spec.packedRefs, 'utf-8');
  }
}

const CANONICAL_HEAD = 'ref: refs/heads/main\n';
const CANONICAL_CONFIG_HTTPS =
  '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';

describe('readGitHeadBranch', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-git-head-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns branch name for a normal symbolic-ref HEAD', () => {
    seedRepo(dir, { head: CANONICAL_HEAD });
    expect(readGitHeadBranch(dir)).toBe('main');
  });

  test('returns branch name with a slash for nested branches', () => {
    seedRepo(dir, { head: 'ref: refs/heads/feat/sharing-virality-flow\n' });
    expect(readGitHeadBranch(dir)).toBe('feat/sharing-virality-flow');
  });

  test('returns null for a detached HEAD (raw SHA)', () => {
    seedRepo(dir, { head: '0123456789abcdef0123456789abcdef01234567\n' });
    expect(readGitHeadBranch(dir)).toBeNull();
  });

  test('returns null when the project has no .git directory', () => {
    expect(readGitHeadBranch(dir)).toBeNull();
  });

  test('returns null when .git/HEAD is missing', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    expect(readGitHeadBranch(dir)).toBeNull();
  });

  test('reads through a worktree pointer file', () => {
    const realGitDir = mkdtempSync(join(tmpdir(), 'share-git-real-'));
    writeFileSync(join(realGitDir, 'HEAD'), 'ref: refs/heads/feature-x\n', 'utf-8');
    seedRepo(dir, { gitDirAsFile: { contents: `gitdir: ${realGitDir}\n` } });
    expect(readGitHeadBranch(dir)).toBe('feature-x');
    rmSync(realGitDir, { recursive: true, force: true });
  });

  test('returns null when .git is an unreadable file (malformed worktree pointer)', () => {
    seedRepo(dir, { gitDirAsFile: { contents: 'not a worktree pointer\n' } });
    expect(readGitHeadBranch(dir)).toBeNull();
  });
});

describe('readOriginGitHubRepo', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-git-origin-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('parses HTTPS github.com origin URL', () => {
    seedRepo(dir, { config: CANONICAL_CONFIG_HTTPS });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
  });

  test('parses SSH SCP-style github.com origin URL', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git@github.com:inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
  });

  test('parses ssh:// github.com origin URL', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = ssh://git@github.com/inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
  });

  test('returns ok when repo URL omits the .git suffix', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
  });

  test('returns non-github for gitlab origin URL', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git@gitlab.com:inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'non-github' });
  });

  test('presumes an unknown host is a GitHub Enterprise host', () => {
    // GHES hostnames are arbitrary, so unknown hosts classify as GitHub with
    // the host carried in the result. A self-hosted non-GitHub forge on a
    // custom domain is indistinguishable and lands here too — downstream
    // consumers degrade gracefully for it.
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://ghes.acme.test/inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'ghes.acme.test',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
  });

  test('parses scp-style GHES origin and carries the host', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git@github.corp.example.com:team/kb.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.corp.example.com',
      owner: 'team',
      repo: 'kb',
    });
  });

  test('strips a non-standard port from a GHES host', () => {
    // Downstream consumers (`gh auth token --hostname`, the `/api/v3` probe
    // base) address the host by name; a retained `:8443` would break both.
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://ghes.acme.test:8443/acme/kb.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'ghes.acme.test',
      owner: 'acme',
      repo: 'kb',
    });
  });

  test('parses the git:// protocol form', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git://github.com/inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
  });

  test('normalizes host casing, port, and www-folding', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://WWW.GitHub.com:443/inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
  });

  test('returns no-remote when [remote "origin"] section is absent', () => {
    seedRepo(dir, { config: '[core]\n\trepositoryformatversion = 0\n' });
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'no-remote' });
  });

  test('returns no-remote when origin section exists but has no url', () => {
    seedRepo(dir, { config: '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' });
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'no-remote' });
  });

  test('returns no-remote when .git/config is missing', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'no-remote' });
  });

  test('returns no-remote when the project has no .git at all', () => {
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'no-remote' });
  });

  test('treats unparseable origin url as non-github (defensive — origin field present but malformed)', () => {
    seedRepo(dir, { config: '[remote "origin"]\n\turl = totally-bogus\n' });
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'non-github' });
  });

  test('credential-embedded https URLs classify as non-github (documented limitation)', () => {
    // The https form deliberately excludes userinfo, matching the cli's
    // `parseGitUrl` grammar — a `user:pass@host` origin falls through to
    // `non-github` (and downstream host defaults fall back to github.com),
    // the same treatment such URLs received for github.com itself.
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://user:pass@ghes.corp.example/org/repo.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'non-github' });
  });

  test('uses the first url= line and ignores subsequent ones', () => {
    seedRepo(dir, {
      config:
        '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n\turl = https://gitlab.com/x/y.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
  });

  test('ignores url lines from other remote sections', () => {
    seedRepo(dir, {
      config:
        '[remote "upstream"]\n\turl = https://github.com/upstream/foo.git\n[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
  });
});

describe('originGitHubHost', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-git-host-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns github.com for a github.com origin', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
    });
    expect(originGitHubHost(dir)).toBe('github.com');
  });

  test('returns the enterprise host for a GHES origin', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://ghes.acme.test/acme/kb.git\n',
    });
    expect(originGitHubHost(dir)).toBe('ghes.acme.test');
  });

  test('falls back to github.com for a known non-GitHub forge', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git@gitlab.com:team/notes.git\n',
    });
    expect(originGitHubHost(dir)).toBe('github.com');
  });

  test('falls back to github.com when there is no .git at all', () => {
    expect(originGitHubHost(dir)).toBe('github.com');
  });
});

describe('branchExistsOnOrigin', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-git-branch-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns true when a loose ref exists', () => {
    seedRepo(dir, { branchRefs: { main: 'abc123\n' } });
    expect(branchExistsOnOrigin(dir, 'main')).toBe(true);
  });

  test('returns false when no ref file exists', () => {
    seedRepo(dir, { branchRefs: { main: 'abc123\n' } });
    expect(branchExistsOnOrigin(dir, 'feature-x')).toBe(false);
  });

  test('returns true for a packed-refs entry', () => {
    seedRepo(dir, {
      packedRefs:
        '# pack-refs with: peeled fully-peeled sorted\nabc123 refs/remotes/origin/main\ndef456 refs/remotes/origin/develop\n',
    });
    expect(branchExistsOnOrigin(dir, 'develop')).toBe(true);
  });

  test('returns false for an absent packed-refs entry', () => {
    seedRepo(dir, {
      packedRefs: '# pack-refs with: peeled fully-peeled sorted\nabc123 refs/remotes/origin/main\n',
    });
    expect(branchExistsOnOrigin(dir, 'feature-x')).toBe(false);
  });

  test('returns true when the branch is loose AND packed (loose wins)', () => {
    seedRepo(dir, {
      branchRefs: { main: 'abc123\n' },
      packedRefs: '# pack-refs with: peeled fully-peeled sorted\ndef456 refs/remotes/origin/main\n',
    });
    expect(branchExistsOnOrigin(dir, 'main')).toBe(true);
  });

  test('returns false when no .git at all', () => {
    expect(branchExistsOnOrigin(dir, 'main')).toBe(false);
  });

  test('handles branches with slashes in loose-ref form', () => {
    seedRepo(dir, { branchRefs: { 'feat/sharing': 'abc\n' } });
    expect(branchExistsOnOrigin(dir, 'feat/sharing')).toBe(true);
  });

  test('handles branches with slashes via packed-refs', () => {
    seedRepo(dir, {
      packedRefs: 'abc123 refs/remotes/origin/feat/sharing-virality-flow\n',
    });
    expect(branchExistsOnOrigin(dir, 'feat/sharing-virality-flow')).toBe(true);
  });
});

describe('readSyncRemoteInfo', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-git-remote-info-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('GitHub https origin yields owner/repo label + browsable webUrl', () => {
    seedRepo(dir, { config: CANONICAL_CONFIG_HTTPS });
    expect(readSyncRemoteInfo(dir)).toEqual({
      label: 'inkeep/open-knowledge',
      webUrl: 'https://github.com/inkeep/open-knowledge',
    });
  });

  test('GitHub scp-style ssh origin yields the same github webUrl', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git@github.com:inkeep/open-knowledge.git\n',
    });
    expect(readSyncRemoteInfo(dir)).toEqual({
      label: 'inkeep/open-knowledge',
      webUrl: 'https://github.com/inkeep/open-knowledge',
    });
  });

  test('GHES origin yields a host-qualified label and a browsable webUrl', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://ghes.acme.test/team/notes.git\n',
    });
    expect(readSyncRemoteInfo(dir)).toEqual({
      label: 'ghes.acme.test/team/notes',
      webUrl: 'https://ghes.acme.test/team/notes',
    });
  });

  test('known non-github forge yields a readable label and a null webUrl (no link)', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://gitlab.com/team/notes.git\n',
    });
    expect(readSyncRemoteInfo(dir)).toEqual({
      label: 'gitlab.com/team/notes',
      webUrl: null,
    });
  });

  test('non-github scp-style ssh origin strips credentials into host/path label', () => {
    seedRepo(dir, { config: '[remote "origin"]\n\turl = git@gitlab.com:team/notes.git\n' });
    expect(readSyncRemoteInfo(dir)).toEqual({ label: 'gitlab.com/team/notes', webUrl: null });
  });

  test('non-github https origin with embedded credentials (incl. @ in password) leaks none', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://user:p@ss@gitlab.com/org/repo.git\n',
    });
    // The `@`-in-password segment must be fully consumed — no `ss@gitlab...` leak.
    expect(readSyncRemoteInfo(dir)).toEqual({ label: 'gitlab.com/org/repo', webUrl: null });
  });

  test('returns null when no origin url is configured', () => {
    seedRepo(dir, { config: '[core]\n\tbare = false\n' });
    expect(readSyncRemoteInfo(dir)).toBeNull();
  });

  test('returns null when the project has no .git at all', () => {
    expect(readSyncRemoteInfo(dir)).toBeNull();
  });
});

describe('linked-worktree common-dir resolution', () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'share-git-worktree-'));
    // Common (main) git dir: holds config + remote-tracking refs — NOT the
    // per-worktree git dir.
    const commonDir = join(root, 'main-git');
    mkdirSync(commonDir, { recursive: true });
    writeFileSync(join(commonDir, 'config'), CANONICAL_CONFIG_HTTPS, 'utf-8');
    const refDir = join(commonDir, 'refs', 'remotes', 'origin');
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, 'feat-bar'), 'abc123\n', 'utf-8');
    // Linked-worktree git dir: per-worktree HEAD + a relative `commondir`
    // pointer, exactly as git writes it (`.git/worktrees/<name>/commondir`).
    const worktreeGitDir = join(commonDir, 'worktrees', 'wt');
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feat-bar\n', 'utf-8');
    writeFileSync(
      join(worktreeGitDir, 'commondir'),
      `${relative(worktreeGitDir, commonDir)}\n`,
      'utf-8',
    );
    // The worktree checkout: its `.git` is a file pointing at the worktree dir.
    project = join(root, 'wt-checkout');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('reads origin config via commondir (regression: worktree reported no-remote)', () => {
    expect(readOriginGitHubRepo(project)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
  });

  test('readSyncRemoteInfo resolves the common-dir origin for a worktree', () => {
    expect(readSyncRemoteInfo(project)).toEqual({
      label: 'inkeep/open-knowledge',
      webUrl: 'https://github.com/inkeep/open-knowledge',
    });
  });

  test('branchExistsOnOrigin reads remote-tracking refs from the common dir', () => {
    expect(branchExistsOnOrigin(project, 'feat-bar')).toBe(true);
    expect(branchExistsOnOrigin(project, 'nope')).toBe(false);
  });

  test('HEAD still resolves from the per-worktree git dir, not the common dir', () => {
    expect(readGitHeadBranch(project)).toBe('feat-bar');
  });
});
