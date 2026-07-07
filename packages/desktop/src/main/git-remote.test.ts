import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { extractOriginUrl, readCanonicalGitHubRemoteUrl } from './git-remote.ts';

describe('extractOriginUrl', () => {
  test('returns the url from a canonical [remote "origin"] block', () => {
    const config = [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "origin"]',
      '\turl = https://github.com/inkeep/open-knowledge.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '',
    ].join('\n');
    expect(extractOriginUrl(config)).toBe('https://github.com/inkeep/open-knowledge.git');
  });

  test("returns the SSH form unchanged (canonicalization is the caller's job)", () => {
    const config = ['[remote "origin"]', '\turl = git@github.com:inkeep/open-knowledge.git'].join(
      '\n',
    );
    expect(extractOriginUrl(config)).toBe('git@github.com:inkeep/open-knowledge.git');
  });

  test('ignores [remote "upstream"] when origin is also present', () => {
    const config = [
      '[remote "upstream"]',
      '\turl = https://github.com/some/fork.git',
      '[remote "origin"]',
      '\turl = https://github.com/inkeep/open-knowledge.git',
    ].join('\n');
    expect(extractOriginUrl(config)).toBe('https://github.com/inkeep/open-knowledge.git');
  });

  test('returns null when no origin section is present', () => {
    const config = ['[core]', '\trepositoryformatversion = 0'].join('\n');
    expect(extractOriginUrl(config)).toBeNull();
  });

  test('returns null when origin section has no url key', () => {
    const config = ['[remote "origin"]', '\tfetch = +refs/heads/*:refs/remotes/origin/*'].join(
      '\n',
    );
    expect(extractOriginUrl(config)).toBeNull();
  });

  test('tolerates CRLF line endings', () => {
    const config = [
      '[core]\r',
      '\trepositoryformatversion = 0\r',
      '[remote "origin"]\r',
      '\turl = https://github.com/inkeep/open-knowledge.git\r',
    ].join('\n');
    expect(extractOriginUrl(config)).toBe('https://github.com/inkeep/open-knowledge.git');
  });

  test('handles quoted url values', () => {
    const config = [
      '[remote "origin"]',
      '\turl = "https://github.com/inkeep/open-knowledge.git"',
    ].join('\n');
    expect(extractOriginUrl(config)).toBe('https://github.com/inkeep/open-knowledge.git');
  });

  test('strips trailing semicolon and hash comments', () => {
    const config = [
      '[remote "origin"]',
      '\turl = https://github.com/inkeep/open-knowledge.git ; was example/old.git',
    ].join('\n');
    expect(extractOriginUrl(config)).toBe('https://github.com/inkeep/open-knowledge.git');
  });
});

describe('readCanonicalGitHubRemoteUrl (filesystem round-trip)', () => {
  function withTempProject(setup: (projectDir: string) => void): string | null {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-git-remote-'));
    try {
      setup(projectDir);
      return readCanonicalGitHubRemoteUrl(projectDir);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }

  test('returns canonical https form for an https origin', () => {
    const result = withTempProject((projectDir) => {
      mkdirSync(join(projectDir, '.git'));
      writeFileSync(
        join(projectDir, '.git', 'config'),
        '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
      );
    });
    expect(result).toBe('https://github.com/inkeep/open-knowledge.git');
  });

  test('canonicalizes an SSH origin to the https form', () => {
    const result = withTempProject((projectDir) => {
      mkdirSync(join(projectDir, '.git'));
      writeFileSync(
        join(projectDir, '.git', 'config'),
        '[remote "origin"]\n\turl = git@github.com:inkeep/open-knowledge.git\n',
      );
    });
    expect(result).toBe('https://github.com/inkeep/open-knowledge.git');
  });

  test('returns null when .git/config is absent (not a git repo)', () => {
    const result = withTempProject(() => {
      // No .git directory at all.
    });
    expect(result).toBeNull();
  });

  test('returns null when origin points at a non-github host (e.g. gitlab.com)', () => {
    const result = withTempProject((projectDir) => {
      mkdirSync(join(projectDir, '.git'));
      writeFileSync(
        join(projectDir, '.git', 'config'),
        '[remote "origin"]\n\turl = https://gitlab.com/inkeep/open-knowledge.git\n',
      );
    });
    expect(result).toBeNull();
  });

  test('returns null when origin url is unparseable', () => {
    const result = withTempProject((projectDir) => {
      mkdirSync(join(projectDir, '.git'));
      writeFileSync(join(projectDir, '.git', 'config'), '[remote "origin"]\n\turl = not-a-url\n');
    });
    expect(result).toBeNull();
  });

  test('does not throw when .git/config is unreadable', () => {
    // Project dir exists, .git/config does not — read fails silently.
    const result = withTempProject((projectDir) => {
      mkdirSync(join(projectDir, '.git'));
      // No config file written.
    });
    expect(result).toBeNull();
  });

  test('follows worktree `.git` pointer file to read the linked gitdir config', () => {
    // Simulate a git worktree: primary checkout owns `.git/worktrees/feature/`,
    // and the worktree's `.git` is a regular file pointing at that gitdir.
    const result = withTempProject((projectDir) => {
      const primaryDir = join(projectDir, '..', 'ok-git-remote-primary-');
      const primaryGitDir = `${primaryDir}-gitdir`;
      mkdirSync(primaryGitDir, { recursive: true });
      writeFileSync(
        join(primaryGitDir, 'config'),
        '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
      );
      // Worktree's `.git` is a FILE containing `gitdir: <path>`, not a dir.
      writeFileSync(join(projectDir, '.git'), `gitdir: ${primaryGitDir}\n`);
    });
    expect(result).toBe('https://github.com/inkeep/open-knowledge.git');
  });

  test('returns null when worktree pointer file targets a missing gitdir', () => {
    const result = withTempProject((projectDir) => {
      writeFileSync(join(projectDir, '.git'), 'gitdir: /tmp/this/does/not/exist\n');
    });
    expect(result).toBeNull();
  });

  test('returns null when `.git` file lacks a `gitdir:` line (malformed pointer)', () => {
    const result = withTempProject((projectDir) => {
      writeFileSync(join(projectDir, '.git'), 'not a worktree pointer\n');
    });
    expect(result).toBeNull();
  });

  test('follows the worktree commondir pointer to read origin config from the common dir', () => {
    // A real linked worktree: its gitdir holds HEAD + a `commondir` pointer but
    // NO `config` — origin config lives in the shared common dir. Before the
    // commondir resolution this returned null and the worktree project silently
    // missed on share-receive (it fell back to the clone/locate dialog).
    const result = withTempProject((projectDir) => {
      const commonDir = join(projectDir, 'main-git');
      mkdirSync(commonDir, { recursive: true });
      writeFileSync(
        join(commonDir, 'config'),
        '[remote "origin"]\n\turl = https://github.com/inkeep/ok-git-testing.git\n',
      );
      const worktreeGitDir = join(commonDir, 'worktrees', 'wt');
      mkdirSync(worktreeGitDir, { recursive: true });
      // Relative `commondir` pointer, exactly as git writes it. No config here.
      writeFileSync(join(worktreeGitDir, 'commondir'), `${relative(worktreeGitDir, commonDir)}\n`);
      writeFileSync(join(projectDir, '.git'), `gitdir: ${worktreeGitDir}\n`);
    });
    expect(result).toBe('https://github.com/inkeep/ok-git-testing.git');
  });
});
