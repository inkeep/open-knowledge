import { describe, expect, test } from 'vitest';
import {
  agentToolDirs,
  augmentAgentSpawnPath,
  augmentGitSpawnPath,
  wellKnownToolDirs,
} from './git-spawn-path.ts';

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

describe('augmentAgentSpawnPath', () => {
  test('appends package-manager global bins on top of the well-known dirs', () => {
    const out = augmentAgentSpawnPath(
      '/usr/bin:/bin',
      darwinOpts([`${HOME}/Library/pnpm`, '/opt/homebrew/bin']),
    );
    // Well-known dirs come first, then the PM-global dirs — both append-only.
    expect(out).toBe(`/usr/bin:/bin:/opt/homebrew/bin:${HOME}/Library/pnpm`);
  });

  test('resolves an agent CLI dir (~/Library/pnpm) that the git variant omits', () => {
    const opts = darwinOpts([`${HOME}/Library/pnpm`]);
    expect(augmentAgentSpawnPath('/usr/bin', opts).split(':')).toContain(`${HOME}/Library/pnpm`);
    // Pure superset: the git variant must NOT pick up the agent-only dir.
    expect(augmentGitSpawnPath('/usr/bin', opts).split(':')).not.toContain(`${HOME}/Library/pnpm`);
  });

  test('never prepends and is idempotent', () => {
    const opts = darwinOpts(['/opt/homebrew/bin', `${HOME}/.bun/bin`]);
    const once = augmentAgentSpawnPath('/usr/bin', opts);
    expect(once.startsWith('/usr/bin')).toBe(true);
    expect(augmentAgentSpawnPath(once, opts)).toBe(once);
  });

  test('skips dirs that do not exist on disk', () => {
    expect(augmentAgentSpawnPath('/usr/bin', darwinOpts([]))).toBe('/usr/bin');
  });
});

describe('agentToolDirs', () => {
  test('darwin lists every JS package-manager global bin', () => {
    expect(agentToolDirs('darwin', HOME)).toEqual([
      `${HOME}/Library/pnpm`,
      `${HOME}/.bun/bin`,
      `${HOME}/.volta/bin`,
      `${HOME}/.yarn/bin`,
      `${HOME}/.npm-global/bin`,
    ]);
  });

  test('linux uses the XDG pnpm dir, not the macOS Library path', () => {
    expect(agentToolDirs('linux', HOME)).toEqual([
      `${HOME}/.local/share/pnpm`,
      `${HOME}/.bun/bin`,
      `${HOME}/.volta/bin`,
      `${HOME}/.yarn/bin`,
      `${HOME}/.npm-global/bin`,
    ]);
    expect(agentToolDirs('linux', HOME)).not.toContain(`${HOME}/Library/pnpm`);
  });

  test('win32 adds nothing (Explorer inherits the registry user PATH)', () => {
    expect(agentToolDirs('win32', 'C:\\Users\\tester')).toEqual([]);
  });
});
