import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readCanonicalGitHubRemoteUrl } from './git-remote.ts';

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

  test('returns a host-qualified canonical url for a GHES origin', () => {
    const result = withTempProject((projectDir) => {
      mkdirSync(join(projectDir, '.git'));
      writeFileSync(
        join(projectDir, '.git', 'config'),
        '[remote "origin"]\n\turl = https://ghes.acme.test/acme/kb.git\n',
      );
    });
    expect(result).toBe('https://ghes.acme.test/acme/kb.git');
  });

  test('returns null when .git/config is absent (not a git repo)', () => {
    const result = withTempProject(() => {});
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

  test('skips empty entries before the configured origin URL', () => {
    const result = withTempProject((projectDir) => {
      mkdirSync(join(projectDir, '.git'));
      writeFileSync(
        join(projectDir, '.git', 'config'),
        [
          '[remote "origin"]',
          '\turl =',
          '\turl = https://github.com/inkeep/open-knowledge.git',
        ].join('\n'),
      );
    });
    expect(result).toBe('https://github.com/inkeep/open-knowledge.git');
  });

  test('does not throw when .git/config is unreadable', () => {
    const result = withTempProject((projectDir) => {
      mkdirSync(join(projectDir, '.git'));
    });
    expect(result).toBeNull();
  });

  test('follows worktree `.git` pointer file to read the linked gitdir config', () => {
    const result = withTempProject((projectDir) => {
      const primaryDir = join(projectDir, '..', 'ok-git-remote-primary-');
      const primaryGitDir = `${primaryDir}-gitdir`;
      mkdirSync(primaryGitDir, { recursive: true });
      writeFileSync(
        join(primaryGitDir, 'config'),
        '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
      );
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
    const result = withTempProject((projectDir) => {
      const commonDir = join(projectDir, 'main-git');
      mkdirSync(commonDir, { recursive: true });
      writeFileSync(
        join(commonDir, 'config'),
        '[remote "origin"]\n\turl = https://github.com/inkeep/ok-git-testing.git\n',
      );
      const worktreeGitDir = join(commonDir, 'worktrees', 'wt');
      mkdirSync(worktreeGitDir, { recursive: true });
      writeFileSync(join(worktreeGitDir, 'commondir'), `${relative(worktreeGitDir, commonDir)}\n`);
      writeFileSync(join(projectDir, '.git'), `gitdir: ${worktreeGitDir}\n`);
    });
    expect(result).toBe('https://github.com/inkeep/ok-git-testing.git');
  });
});
