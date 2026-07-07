import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { validateLocalFolderForShare } from './folder-validator.ts';

describe('validateLocalFolderForShare', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ok-folder-validator-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedRepo(folder: string, originUrl: string | null): void {
    mkdirSync(resolve(folder, '.git'), { recursive: true });
    const config =
      originUrl === null
        ? '[core]\n\trepositoryformatversion = 0\n'
        : `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
    writeFileSync(resolve(folder, '.git', 'config'), config, 'utf-8');
  }

  test('returns ok with canonical https URL when origin matches expected (https clone)', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, 'https://github.com/inkeep/open-knowledge.git');

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
  });

  test('returns ok and normalizes to https for ssh clones', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, 'git@github.com:inkeep/open-knowledge.git');

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
  });

  test('owner / repo comparison is case-insensitive', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, 'https://github.com/Inkeep/Open-Knowledge.git');

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // Re-emitted URL preserves the origin-config casing — receiver's
      // RecentProject lookup also normalizes case so this stays a hit.
      expect(result.gitRemoteUrl).toBe('https://github.com/Inkeep/Open-Knowledge.git');
    }
  });

  test('returns not-git when the folder has no .git', async () => {
    const folder = resolve(tmpDir, 'plain');
    mkdirSync(folder);

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'not-git' });
  });

  test('returns not-git when the folder itself is missing', async () => {
    const folder = resolve(tmpDir, 'does-not-exist');

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'not-git' });
  });

  test('returns not-git when .git is a directory but config is missing', async () => {
    const folder = resolve(tmpDir, 'shell-only');
    mkdirSync(resolve(folder, '.git'), { recursive: true });
    // No config file at all — the "shell-only" git state.

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'not-git' });
  });

  test('returns no-origin when .git/config has no [remote "origin"] section', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, null);

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'no-origin' });
  });

  test('worktree case: .git is a file pointing at the primary checkout gitdir', async () => {
    const primaryDir = resolve(tmpDir, 'primary');
    const primaryGitDir = resolve(primaryDir, '.git');
    mkdirSync(primaryGitDir, { recursive: true });
    writeFileSync(
      resolve(primaryGitDir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
      'utf-8',
    );
    // Worktree-pointer: gitdir under <primary>/.git/worktrees/<name>, but we
    // use the primary's config (the worktree shares the same origin).
    const worktreeFolder = resolve(tmpDir, 'feature-branch');
    mkdirSync(worktreeFolder);
    writeFileSync(resolve(worktreeFolder, '.git'), `gitdir: ${primaryGitDir}\n`, 'utf-8');

    const result = await validateLocalFolderForShare(worktreeFolder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
  });

  test('worktree case: reads origin from the common dir via the gitdir commondir pointer', async () => {
    // Real linked-worktree layout: the worktree gitdir lives under
    // <primary>/.git/worktrees/<name> and holds a `commondir` pointer but NO
    // config of its own — origin config lives in the shared common dir. Before
    // the commondir resolution this returned not-git, which blocked worktree
    // share-receive (the dispatch gate rejected the worktree).
    const primaryGitDir = resolve(tmpDir, 'primary', '.git');
    mkdirSync(primaryGitDir, { recursive: true });
    writeFileSync(
      resolve(primaryGitDir, 'config'),
      '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
      'utf-8',
    );
    const worktreeGitDir = resolve(primaryGitDir, 'worktrees', 'feature');
    mkdirSync(worktreeGitDir, { recursive: true });
    // Relative commondir pointer, exactly as git writes it ('../..' from the
    // worktree gitdir resolves back to the primary .git). No config here.
    writeFileSync(resolve(worktreeGitDir, 'commondir'), '../..\n', 'utf-8');
    const worktreeFolder = resolve(tmpDir, 'feature-wt');
    mkdirSync(worktreeFolder);
    writeFileSync(resolve(worktreeFolder, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf-8');

    const result = await validateLocalFolderForShare(worktreeFolder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
  });

  test('worktree case: malformed .git pointer file returns not-git', async () => {
    const folder = resolve(tmpDir, 'bad-worktree');
    mkdirSync(folder);
    writeFileSync(resolve(folder, '.git'), 'this is not a worktree pointer\n', 'utf-8');

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'not-git' });
  });

  test('worktree case: gitdir pointer targets a missing path returns not-git', async () => {
    const folder = resolve(tmpDir, 'orphan-worktree');
    mkdirSync(folder);
    writeFileSync(resolve(folder, '.git'), `gitdir: ${resolve(tmpDir, 'no-such-dir')}\n`, 'utf-8');

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'not-git' });
  });

  test('returns non-github when origin points at gitlab', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, 'git@gitlab.com:inkeep/open-knowledge.git');

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'non-github' });
  });

  test('returns non-github when origin URL is unparseable', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, 'this-is-not-a-url');

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'non-github' });
  });

  test('returns wrong-repo with the actual owner when only owner differs', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, 'https://github.com/someone-else/open-knowledge.git');

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({
      kind: 'wrong-repo',
      actualOwner: 'someone-else',
      actualRepo: 'open-knowledge',
    });
  });

  test('returns wrong-repo with the actual repo when only repo differs', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, 'https://github.com/inkeep/different-repo.git');

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({
      kind: 'wrong-repo',
      actualOwner: 'inkeep',
      actualRepo: 'different-repo',
    });
  });

  test('returns symlink-escape when the picked folder is a symlink that resolves outside its parent', async () => {
    // /tmp/xxx/escape-target — the folder we don't want to read from
    const escapeTarget = resolve(tmpDir, 'escape-target');
    mkdirSync(escapeTarget);
    seedRepo(escapeTarget, 'https://github.com/attacker/secrets.git');

    // /tmp/xxx/parent/picked — symlink pointing outside parent's tree
    const parent = resolve(tmpDir, 'parent');
    mkdirSync(parent);
    const picked = resolve(parent, 'picked');
    symlinkSync(escapeTarget, picked);

    const result = await validateLocalFolderForShare(picked, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'symlink-escape' });
  });

  test('returns symlink-escape when .git itself is a symlink to an outside directory', async () => {
    // /tmp/xxx/elsewhere — a directory containing a config that masquerades
    // as a github origin matching the expected repo.
    const elsewhere = resolve(tmpDir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(
      resolve(elsewhere, 'config'),
      '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
      'utf-8',
    );

    // /tmp/xxx/folder — .git is a symlink to /tmp/xxx/elsewhere
    const folder = resolve(tmpDir, 'folder');
    mkdirSync(folder);
    symlinkSync(elsewhere, resolve(folder, '.git'));

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'symlink-escape' });
  });

  test('legitimate symlinked folder under its own parent still validates ok', async () => {
    // Common macOS / iCloud case: a folder is a symlink to a sibling under
    // the same parent. Should validate normally.
    const realFolder = resolve(tmpDir, 'real-folder');
    mkdirSync(realFolder);
    seedRepo(realFolder, 'https://github.com/inkeep/open-knowledge.git');

    const linkFolder = resolve(tmpDir, 'link-folder');
    symlinkSync(realFolder, linkFolder);

    const result = await validateLocalFolderForShare(linkFolder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result.kind).toBe('ok');
  });

  test('tolerates CRLF line endings + comments in .git/config', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    mkdirSync(resolve(folder, '.git'));
    const config = [
      '[core]',
      '; comment line with semicolon',
      '\trepositoryformatversion = 0',
      '[remote "origin"]',
      '\turl = https://github.com/inkeep/open-knowledge.git # trailing comment',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ].join('\r\n');
    writeFileSync(resolve(folder, '.git', 'config'), config, 'utf-8');

    const result = await validateLocalFolderForShare(folder, {
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
  });
});
