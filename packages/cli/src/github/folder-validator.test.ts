import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
  });

  test('a userinfo origin validates ok, and the canonical URL carries no credential', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, 'https://alice:s3cretpw@github.com/inkeep/open-knowledge.git');

    const result = await validateLocalFolderForShare(folder, {
      host: 'github.com',
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
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
  });

  test('accepts a GHES clone and re-emits a host-qualified canonical url', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, 'https://ghes.acme.test/acme/kb.git');

    const result = await validateLocalFolderForShare(folder, {
      host: 'ghes.acme.test',
      owner: 'acme',
      repo: 'kb',
    });
    expect(result).toEqual({
      kind: 'ok',
      gitRemoteUrl: 'https://ghes.acme.test/acme/kb.git',
    });
  });

  test('a github.com clone of the same owner/repo is a host mismatch, not wrong-repo', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, 'https://github.com/acme/kb.git');

    const result = await validateLocalFolderForShare(folder, {
      host: 'ghes.acme.test',
      owner: 'acme',
      repo: 'kb',
    });
    expect(result).toEqual({ kind: 'wrong-host', actualHost: 'github.com' });
  });

  test('a GHES clone offered for a github.com share is also a host mismatch', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, 'https://ghes.acme.test/acme/kb.git');

    const result = await validateLocalFolderForShare(folder, {
      host: 'github.com',
      owner: 'acme',
      repo: 'kb',
    });
    expect(result).toEqual({ kind: 'wrong-host', actualHost: 'ghes.acme.test' });
  });

  test('owner / repo comparison is case-insensitive', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, 'https://github.com/Inkeep/Open-Knowledge.git');

    const result = await validateLocalFolderForShare(folder, {
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.gitRemoteUrl).toBe('https://github.com/Inkeep/Open-Knowledge.git');
    }
  });

  test('returns not-git when the folder has no .git', async () => {
    const folder = resolve(tmpDir, 'plain');
    mkdirSync(folder);

    const result = await validateLocalFolderForShare(folder, {
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'not-git' });
  });

  test('returns not-git when the folder itself is missing', async () => {
    const folder = resolve(tmpDir, 'does-not-exist');

    const result = await validateLocalFolderForShare(folder, {
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'not-git' });
  });

  test('returns not-git when .git is a directory but config is missing', async () => {
    const folder = resolve(tmpDir, 'shell-only');
    mkdirSync(resolve(folder, '.git'), { recursive: true });

    const result = await validateLocalFolderForShare(folder, {
      host: 'github.com',
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
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'no-origin' });
  });

  test('returns no-origin when the origin URL is an empty quoted value', async () => {
    const folder = resolve(tmpDir, 'repo');
    mkdirSync(folder);
    seedRepo(folder, '""');

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
    const worktreeFolder = resolve(tmpDir, 'feature-branch');
    mkdirSync(worktreeFolder);
    writeFileSync(resolve(worktreeFolder, '.git'), `gitdir: ${primaryGitDir}\n`, 'utf-8');

    const result = await validateLocalFolderForShare(worktreeFolder, {
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
  });

  test('worktree case: reads origin from the common dir via the gitdir commondir pointer', async () => {
    const primaryGitDir = resolve(tmpDir, 'primary', '.git');
    mkdirSync(primaryGitDir, { recursive: true });
    writeFileSync(
      resolve(primaryGitDir, 'config'),
      '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
      'utf-8',
    );
    const worktreeGitDir = resolve(primaryGitDir, 'worktrees', 'feature');
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(resolve(worktreeGitDir, 'commondir'), '../..\n', 'utf-8');
    const worktreeFolder = resolve(tmpDir, 'feature-wt');
    mkdirSync(worktreeFolder);
    writeFileSync(resolve(worktreeFolder, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf-8');

    const result = await validateLocalFolderForShare(worktreeFolder, {
      host: 'github.com',
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
      host: 'github.com',
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
      host: 'github.com',
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
      host: 'github.com',
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
      host: 'github.com',
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
      host: 'github.com',
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
      host: 'github.com',
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
    const escapeTarget = resolve(tmpDir, 'escape-target');
    mkdirSync(escapeTarget);
    seedRepo(escapeTarget, 'https://github.com/attacker/secrets.git');

    const parent = resolve(tmpDir, 'parent');
    mkdirSync(parent);
    const picked = resolve(parent, 'picked');
    symlinkSync(escapeTarget, picked);

    const result = await validateLocalFolderForShare(picked, {
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'symlink-escape' });
  });

  test('returns symlink-escape when .git itself is a symlink to an outside directory', async () => {
    const elsewhere = resolve(tmpDir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(
      resolve(elsewhere, 'config'),
      '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
      'utf-8',
    );

    const folder = resolve(tmpDir, 'folder');
    mkdirSync(folder);
    symlinkSync(elsewhere, resolve(folder, '.git'));

    const result = await validateLocalFolderForShare(folder, {
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({ kind: 'symlink-escape' });
  });

  test('legitimate symlinked folder under its own parent still validates ok', async () => {
    const realFolder = resolve(tmpDir, 'real-folder');
    mkdirSync(realFolder);
    seedRepo(realFolder, 'https://github.com/inkeep/open-knowledge.git');

    const linkFolder = resolve(tmpDir, 'link-folder');
    symlinkSync(realFolder, linkFolder);

    const result = await validateLocalFolderForShare(linkFolder, {
      host: 'github.com',
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
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(result).toEqual({
      kind: 'ok',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
  });
});
