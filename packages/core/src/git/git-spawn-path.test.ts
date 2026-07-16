import { describe, expect, test } from 'bun:test';
import { augmentGitSpawnPath, wellKnownToolDirs } from './git-spawn-path.ts';

const HOME = '/Users/tester';

function darwinOpts(existing: readonly string[]) {
  const set = new Set(existing);
  return {
    platform: 'darwin' as const,
    homeDir: HOME,
    isDir: (dir: string) => set.has(dir),
    delimiter: ':',
  };
}

describe('augmentGitSpawnPath', () => {
  test('appends existing well-known dirs to a minimal launchd PATH', () => {
    const out = augmentGitSpawnPath(
      '/usr/bin:/bin:/usr/sbin:/sbin',
      darwinOpts(['/opt/homebrew/bin']),
    );
    expect(out).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin');
  });

  test('never prepends — existing entries keep resolution priority', () => {
    const out = augmentGitSpawnPath('/usr/bin', darwinOpts(['/opt/homebrew/bin']));
    expect(out.startsWith('/usr/bin')).toBe(true);
  });

  test('skips directories that do not exist on disk', () => {
    const out = augmentGitSpawnPath('/usr/bin', darwinOpts([]));
    expect(out).toBe('/usr/bin');
  });

  test('does not duplicate a well-known dir already on PATH', () => {
    const out = augmentGitSpawnPath(
      '/opt/homebrew/bin:/usr/bin',
      darwinOpts(['/opt/homebrew/bin']),
    );
    expect(out).toBe('/opt/homebrew/bin:/usr/bin');
  });

  test('is idempotent', () => {
    const opts = darwinOpts(['/opt/homebrew/bin', '/usr/local/bin']);
    const once = augmentGitSpawnPath('/usr/bin', opts);
    expect(augmentGitSpawnPath(once, opts)).toBe(once);
  });

  test('yields the well-known dirs alone when PATH is undefined or empty', () => {
    expect(augmentGitSpawnPath(undefined, darwinOpts(['/usr/local/bin']))).toBe('/usr/local/bin');
    expect(augmentGitSpawnPath('', darwinOpts(['/usr/local/bin']))).toBe('/usr/local/bin');
  });

  test('adds nothing on win32 (Git for Windows manages its own PATH)', () => {
    const out = augmentGitSpawnPath('C:\\Windows', {
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
      isDir: () => true,
      delimiter: ';',
    });
    expect(out).toBe('C:\\Windows');
  });

  test('darwin dir list covers both Homebrew prefixes and shim dirs', () => {
    const dirs = wellKnownToolDirs('darwin', HOME);
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs).toContain(`${HOME}/.asdf/shims`);
  });

  // The CLI is cross-platform and Linux-tested — a regression in the default
  // (Linux) list would leave git helpers unresolvable on Linux hosts with no
  // other signal.
  test('linux (default) dir list covers linuxbrew and shim dirs but not macOS prefixes', () => {
    const dirs = wellKnownToolDirs('linux', HOME);
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs).toContain('/home/linuxbrew/.linuxbrew/bin');
    expect(dirs).toContain(`${HOME}/.asdf/shims`);
    expect(dirs).toContain(`${HOME}/.local/share/mise/shims`);
    expect(dirs).not.toContain('/opt/homebrew/bin');
    expect(dirs).not.toContain('/opt/local/bin');
  });
});
