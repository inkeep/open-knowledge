import { execFile } from 'node:child_process';
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
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { readGitDirKind } from './read-git-dir-kind.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

describe('readGitDirKind', () => {
  let testRoot: string | null = null;
  afterEach(() => {
    if (testRoot !== null) rmSync(testRoot, { recursive: true, force: true });
    testRoot = null;
  });

  test('returns "absent" when path has no .git', () => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gitdir-kind-')));
    expect(readGitDirKind(testRoot)).toBe('absent');
  });

  test('returns "absent" for a non-absolute path (defensive)', () => {
    expect(readGitDirKind('relative/path')).toBe('absent');
  });

  test('returns "directory" for a main checkout (.git is a directory)', async () => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gitdir-kind-')));
    await git(testRoot, 'init', '--initial-branch=main', '.');
    expect(readGitDirKind(testRoot)).toBe('directory');
  });

  test('returns "linked" for a linked-worktree root (.git is a pointer file)', async () => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gitdir-kind-')));
    const mainRepo = join(testRoot, 'main');
    mkdirSync(mainRepo);
    await git(mainRepo, 'init', '--initial-branch=main', '.');
    await git(mainRepo, 'config', 'user.email', 'test@example.com');
    await git(mainRepo, 'config', 'user.name', 'Test');
    writeFileSync(join(mainRepo, 'README.md'), '# main\n');
    await git(mainRepo, 'add', 'README.md');
    await git(mainRepo, 'commit', '-m', 'initial');
    const wt = join(testRoot, 'wt-feat');
    await git(mainRepo, 'worktree', 'add', '-b', 'feat', wt);
    expect(readGitDirKind(wt)).toBe('linked');
  });

  test('returns "absent" for a shell .git/ that holds only a shadow repo, not a checkout', () => {
    // Fixture is what `initShadowRepo` itself leaves behind on a no-repo path.
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gitdir-kind-')));
    mkdirSync(join(testRoot, '.git', 'ok'), { recursive: true });
    expect(readGitDirKind(testRoot)).toBe('absent');
  });

  test('returns "malformed-pointer" for a linked worktree whose admin gitdir is gone', () => {
    // Fixture is a pointer that parses cleanly but targets nothing — what an
    // `rm -rf` of the admin dir without `git worktree prune` leaves.
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gitdir-kind-')));
    writeFileSync(join(testRoot, '.git'), `gitdir: ${join(testRoot, 'gone', 'worktrees', 'x')}\n`);
    expect(readGitDirKind(testRoot)).toBe('malformed-pointer');
  });

  test('returns "absent" for a plain subfolder of a real repo (the .git is the ancestor\'s)', async () => {
    // Fixture has no `.git` of its own, so the walk-up finds the repo's.
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gitdir-kind-')));
    await git(testRoot, 'init', '--initial-branch=main', '.');
    const sub = join(testRoot, 'subfolder');
    mkdirSync(sub);
    expect(readGitDirKind(sub)).toBe('absent');
  });

  test('returns "inaccessible" for a real checkout whose gitdir cannot be traversed', () => {
    // A HEAD we cannot look at is not the same as a HEAD that isn't there:
    // this must not collapse onto the moved-away-ghost classification, or the
    // share path's drop log can no longer tell an ACL problem from a folder
    // the user moved.
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gitdir-kind-')));
    const gitDir = join(testRoot, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    chmodSync(gitDir, 0o000);
    // Skip where chmod 0o000 is bypassed (root); the assertion would be vacuous.
    let stillReadable = false;
    try {
      readFileSync(join(gitDir, 'HEAD'), 'utf-8');
      stillReadable = true;
    } catch {
      // expected — the mode bits should refuse traversal
    }
    if (stillReadable) {
      chmodSync(gitDir, 0o755);
      return;
    }
    try {
      expect(readGitDirKind(testRoot)).toBe('inaccessible');
    } finally {
      // Restore before afterEach's rmSync, which cannot recurse into 0o000.
      chmodSync(gitDir, 0o755);
    }
  });
});
