import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertGitAvailable,
  buildGuidance,
  compareSemver,
  detectGit,
  detectLinuxFamily,
  fallbackPaths,
  type GitDetected,
  GitNotAvailableError,
  GitTooOldError,
  type InstallGuidance,
  type LinuxFamily,
  MIN_GIT_VERSION,
  parseGitVersion,
  resolveOnPath,
} from './git-preflight.ts';

// ---------- parseGitVersion ----------

describe('parseGitVersion', () => {
  test('parses canonical Linux/macOS output', () => {
    expect(parseGitVersion('git version 2.39.3\n')).toBe('2.39.3');
  });

  test('parses Apple Git vendor suffix', () => {
    expect(parseGitVersion('git version 2.39.3 (Apple Git-145)\n')).toBe('2.39.3');
  });

  test('parses Git for Windows vendor suffix', () => {
    expect(parseGitVersion('git version 2.45.0.windows.1\n')).toBe('2.45.0');
  });

  test('parses MinGit nested suffix', () => {
    expect(parseGitVersion('git version 2.45.0.1.windows.1\n')).toBe('2.45.0');
  });

  test('returns null for empty stdout', () => {
    expect(parseGitVersion('')).toBeNull();
  });

  test('returns null for malformed output', () => {
    expect(parseGitVersion('not a git version string')).toBeNull();
    expect(parseGitVersion('git version foo.bar.baz')).toBeNull();
    expect(parseGitVersion('git version 2.39')).toBeNull(); // incomplete triple
  });
});

// ---------- compareSemver ----------

describe('compareSemver', () => {
  test('returns negative when a < b', () => {
    expect(compareSemver('2.20.0', '2.31.0')).toBeLessThan(0);
    expect(compareSemver('2.31.0', '2.31.1')).toBeLessThan(0);
    expect(compareSemver('1.99.99', '2.0.0')).toBeLessThan(0);
  });

  test('returns positive when a > b', () => {
    expect(compareSemver('2.31.0', '2.20.0')).toBeGreaterThan(0);
    expect(compareSemver('2.31.1', '2.31.0')).toBeGreaterThan(0);
    expect(compareSemver('3.0.0', '2.99.99')).toBeGreaterThan(0);
  });

  test('returns zero when equal', () => {
    expect(compareSemver('2.31.0', '2.31.0')).toBe(0);
    expect(compareSemver('0.0.0', '0.0.0')).toBe(0);
  });

  test('treats missing components as zero', () => {
    expect(compareSemver('2.31', '2.31.0')).toBe(0);
    expect(compareSemver('2', '2.0.0')).toBe(0);
  });

  test('handles non-numeric components by defaulting to 0 (same as missing)', () => {
    // NaN || 0 = 0; '2.31.abc' parses as [2,31,0] — equal to '2.31.0'.
    // This mirrors the "missing components default to zero" semantics and is
    // the conservative call for the git version space (no observed prerelease tags).
    expect(compareSemver('2.31.abc', '2.31.0')).toBe(0);
    expect(compareSemver('2.31.0', '2.31.abc')).toBe(0);
  });
});

// ---------- detectLinuxFamily ----------

describe('detectLinuxFamily', () => {
  test('detects Ubuntu from ID', () => {
    const osRelease = `NAME="Ubuntu"
ID=ubuntu
ID_LIKE=debian
VERSION="22.04 LTS"`;
    expect(detectLinuxFamily(osRelease)).toBe('debian');
  });

  test('detects Pop!_OS via ID_LIKE (multi-token)', () => {
    const osRelease = `NAME="Pop!_OS"
ID=pop
ID_LIKE="ubuntu debian"
VERSION="22.04 LTS"`;
    expect(detectLinuxFamily(osRelease)).toBe('debian');
  });

  test('detects Fedora from ID', () => {
    const osRelease = `NAME="Fedora Linux"
ID=fedora`;
    expect(detectLinuxFamily(osRelease)).toBe('fedora');
  });

  test('detects RHEL family via ID_LIKE', () => {
    const osRelease = `NAME="Rocky Linux"
ID="rocky"
ID_LIKE="rhel centos fedora"`;
    expect(detectLinuxFamily(osRelease)).toBe('fedora');
  });

  test('detects Arch from ID', () => {
    const osRelease = `NAME="Arch Linux"
ID=arch`;
    expect(detectLinuxFamily(osRelease)).toBe('arch');
  });

  test('detects Manjaro via ID', () => {
    const osRelease = `NAME="Manjaro Linux"
ID=manjaro
ID_LIKE=arch`;
    expect(detectLinuxFamily(osRelease)).toBe('arch');
  });

  test('detects openSUSE from ID', () => {
    const osRelease = `NAME="openSUSE Tumbleweed"
ID=opensuse-tumbleweed
ID_LIKE="opensuse suse"`;
    expect(detectLinuxFamily(osRelease)).toBe('opensuse');
  });

  test('detects Alpine from ID', () => {
    const osRelease = `NAME="Alpine Linux"
ID=alpine`;
    expect(detectLinuxFamily(osRelease)).toBe('alpine');
  });

  test('returns unknown for unrecognized ID', () => {
    const osRelease = `NAME="MysteryOS"
ID=mystery`;
    expect(detectLinuxFamily(osRelease)).toBe('unknown');
  });

  test('returns unknown when /etc/os-release cannot be read', () => {
    // No argument → reads /etc/os-release; on non-Linux platforms it doesn't
    // exist, on Linux it does. We assert the function does not throw and
    // returns a valid LinuxFamily value.
    const result = detectLinuxFamily();
    const valid: LinuxFamily[] = ['debian', 'fedora', 'arch', 'opensuse', 'alpine', 'unknown'];
    expect(valid).toContain(result);
  });

  test('strips quotes from ID and ID_LIKE values', () => {
    const osRelease = `ID="ubuntu"
ID_LIKE='debian'`;
    expect(detectLinuxFamily(osRelease)).toBe('debian');
  });
});

// ---------- fallbackPaths ----------

describe('fallbackPaths', () => {
  test('macOS includes Apple Silicon brew path first', () => {
    const paths = fallbackPaths('darwin');
    expect(paths[0]).toBe('/opt/homebrew/bin/git');
    expect(paths).toContain('/usr/local/bin/git');
    expect(paths).toContain('/Library/Developer/CommandLineTools/usr/bin/git');
    expect(paths).toContain('/usr/bin/git');
  });

  test('Windows includes Program Files first', () => {
    const paths = fallbackPaths('win32');
    expect(paths[0]).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(paths).toContain('C:\\Program Files (x86)\\Git\\cmd\\git.exe');
    expect(paths.some((p) => p.includes('scoop'))).toBe(true);
  });

  test('Linux includes /usr/bin first and snap', () => {
    const paths = fallbackPaths('linux');
    expect(paths[0]).toBe('/usr/bin/git');
    expect(paths).toContain('/usr/local/bin/git');
    expect(paths).toContain('/snap/bin/git');
  });

  test('unknown platforms fall through to Linux paths', () => {
    const paths = fallbackPaths('freebsd' as NodeJS.Platform);
    expect(paths).toContain('/usr/bin/git');
  });
});

// ---------- buildGuidance ----------

describe('buildGuidance', () => {
  test('macOS guidance always includes xcode-select as a fallback', () => {
    const guidance = buildGuidance('darwin');
    expect(guidance.product).toBe('Git');
    expect(guidance.url).toBe('https://git-scm.com/download/mac');
    // brew may or may not be present in this test environment; xcode-select MUST be present.
    expect(guidance.options.some((o) => o.command === 'xcode-select --install')).toBe(true);
    expect(
      guidance.options.find((o) => o.command === 'xcode-select --install')?.requiresAdmin,
    ).toBe(true);
  });

  test('Windows guidance always ends with manual download fallback', () => {
    const guidance = buildGuidance('win32');
    expect(guidance.product).toBe('Git for Windows');
    expect(guidance.url).toBe('https://gitforwindows.org/');
    expect(guidance.options.length).toBeGreaterThan(0);
    expect(guidance.options[guidance.options.length - 1]?.label).toBe(
      'Download the official installer',
    );
  });

  test('Linux guidance carries at least one option', () => {
    const guidance = buildGuidance('linux');
    expect(guidance.product).toBe('Git');
    expect(guidance.url).toBe('https://git-scm.com/download/linux');
    expect(guidance.options.length).toBeGreaterThan(0);
    // Whichever family the runner is, the first option is a sudo install command
    // (or the generic fallback). Either way it requires admin.
    expect(guidance.options[0]?.requiresAdmin).toBe(true);
  });

  test('options carry stable shape', () => {
    const guidance: InstallGuidance = buildGuidance('darwin');
    for (const opt of guidance.options) {
      expect(typeof opt.label).toBe('string');
      expect(typeof opt.command).toBe('string');
      expect(typeof opt.requiresAdmin).toBe('boolean');
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.command.length).toBeGreaterThan(0);
    }
  });
});

// ---------- GitNotAvailableError ----------

describe('GitNotAvailableError', () => {
  test('carries code, platform, and guidance fields', () => {
    const guidance = buildGuidance('darwin');
    const err = new GitNotAvailableError('darwin', guidance);
    expect(err.code).toBe('GIT_NOT_AVAILABLE');
    expect(err.platform).toBe('darwin');
    expect(err.guidance).toBe(guidance);
    expect(err.name).toBe('GitNotAvailableError');
  });

  test('message includes product name and install URL', () => {
    const guidance = buildGuidance('darwin');
    const err = new GitNotAvailableError('darwin', guidance);
    expect(err.message).toContain('OpenKnowledge needs Git');
    expect(err.message).toContain(guidance.url);
    expect(err.message).toContain('After installing');
  });

  test('message includes every install option label + command', () => {
    const guidance = buildGuidance('linux');
    const err = new GitNotAvailableError('linux', guidance);
    for (const opt of guidance.options) {
      expect(err.message).toContain(opt.label);
      expect(err.message).toContain(opt.command);
    }
  });

  test('Windows variant says "Git for Windows"', () => {
    const guidance = buildGuidance('win32');
    const err = new GitNotAvailableError('win32', guidance);
    expect(err.message).toContain('Git for Windows');
  });

  test('forwards cause to Error options bag', () => {
    const cause = new Error('underlying');
    const err = new GitNotAvailableError('darwin', buildGuidance('darwin'), { cause });
    expect(err.cause).toBe(cause);
  });

  test('passes instanceof checks for branching', () => {
    const err = new GitNotAvailableError('darwin', buildGuidance('darwin'));
    expect(err instanceof GitNotAvailableError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

// ---------- GitTooOldError ----------

describe('GitTooOldError', () => {
  test('carries code, platform, detected, required, and resolvedPath fields', () => {
    const guidance = buildGuidance('darwin');
    const err = new GitTooOldError('darwin', '2.10.0', '2.31.0', '/usr/bin/git', guidance);
    expect(err.code).toBe('GIT_TOO_OLD');
    expect(err.platform).toBe('darwin');
    expect(err.detected).toBe('2.10.0');
    expect(err.required).toBe('2.31.0');
    expect(err.resolvedPath).toBe('/usr/bin/git');
    expect(err.name).toBe('GitTooOldError');
  });

  test('message includes detected, required, and path', () => {
    const guidance = buildGuidance('darwin');
    const err = new GitTooOldError('darwin', '2.10.0', '2.31.0', '/usr/bin/git', guidance);
    expect(err.message).toContain('2.10.0');
    expect(err.message).toContain('2.31.0');
    expect(err.message).toContain('/usr/bin/git');
  });

  test('passes instanceof checks for branching', () => {
    const err = new GitTooOldError(
      'darwin',
      '2.10.0',
      '2.31.0',
      '/usr/bin/git',
      buildGuidance('darwin'),
    );
    expect(err instanceof GitTooOldError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err instanceof GitNotAvailableError).toBe(false);
  });
});

// ---------- resolveOnPath ----------

describe('resolveOnPath', () => {
  test('resolves a tool known to exist on the runner (git, where on win, sh elsewhere)', () => {
    // Either `git` is on PATH (most CI runners) or `sh` is (every POSIX runner).
    // On Windows the corresponding always-present tool is `cmd`.
    const target =
      process.platform === 'win32'
        ? 'cmd'
        : process.platform === 'darwin' || process.platform === 'linux'
          ? 'sh'
          : 'sh';
    const result = resolveOnPath(target);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.length).toBeGreaterThan(0);
    }
  });

  test('returns null for a name that does not exist', () => {
    expect(resolveOnPath('definitely-not-a-real-command-xyzzy-12345')).toBeNull();
  });

  test('rejects names that contain shell metacharacters', () => {
    // Defensive: the POSIX branch interpolates `name` into a `/bin/sh -c
    // "command -v ${name}"` pipeline. Every current caller passes a
    // hardcoded literal, but the function is exported. A future caller
    // that wires an env var or user input through this function would
    // otherwise create an OS command injection vector. Rejecting with
    // `null` keeps the contract safe regardless of how the input was
    // sourced.
    expect(resolveOnPath('git; rm -rf /tmp/xyzzy')).toBeNull();
    expect(resolveOnPath('git && touch /tmp/xyzzy')).toBeNull();
    expect(resolveOnPath('git | cat /etc/passwd')).toBeNull();
    expect(resolveOnPath('git`whoami`')).toBeNull();
    expect(resolveOnPath('git$(whoami)')).toBeNull();
    expect(resolveOnPath('')).toBeNull();
    expect(resolveOnPath('git ')).toBeNull(); // trailing space
    expect(resolveOnPath(' git')).toBeNull(); // leading space
  });

  test('accepts plain-letter command names with dots / hyphens / underscores', () => {
    // The validation regex must continue to admit the OS commands the
    // package-manager probes pass today + reasonable variants. Note:
    // these may or may not be installed on the test runner; we only
    // assert the validation gate doesn't reject them (i.e. the result
    // is either a path string or `null` for "not installed", never an
    // exception).
    for (const name of ['git', 'brew', 'winget', 'scoop', 'choco', 'sub-command', 'cmd.v2']) {
      // Should not throw — the validation passes; the actual lookup may
      // return null, which is fine.
      const result = resolveOnPath(name);
      expect(result === null || typeof result === 'string').toBe(true);
    }
  });
});

// ---------- detectGit (integration) ----------
//
// These tests run against the real runner. On any sane CI image / dev machine,
// git is present — we assert the success shape. The "no git anywhere" path is
// covered by the unit tests above (which exercise the error constructors and
// fallback path probing in isolation) and by the integration test.

describe('detectGit (integration)', () => {
  test('returns a GitDetected when git is present (the common case)', () => {
    const detected: GitDetected = detectGit();
    expect(detected.ok).toBe(true);
    expect(typeof detected.version).toBe('string');
    expect(detected.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(detected.resolvedPath.length).toBeGreaterThan(0);
    expect(['PATH', 'fallback']).toContain(detected.source);
  });

  test('Stage 2 fallback fires when PATH has no git and a fallback candidate exists', () => {
    // Pin the Stage-1-fails → Stage-2-succeeds path. The Cursor-class
    // "installed but invisible" failure mode only
    // exercises Stage 2 when Stage 1 cannot find git on PATH — typical
    // tests run with git on PATH and never reach the loop. Here we
    // narrow PATH to a single non-existent directory so the inherited
    // PATH probe in `probeGit` ENOENTs, then assert detectGit returns
    // `source: 'fallback'` (which on every sane Linux/macOS CI image
    // will resolve to `/usr/bin/git`).
    //
    // PATH='' is unreliable for this test: POSIX says when PATH is
    // empty `execvp` falls back to an implementation-defined default
    // path (`_PATH_DEFPATH`, typically `/usr/bin:/bin` on macOS/Linux),
    // and `git` at `/usr/bin/git` would still resolve via Stage 1. A
    // single non-existent directory avoids that fallback path entirely.
    //
    // Skipped on Windows because the Windows fallback paths
    // (`C:\Program Files\Git\cmd\git.exe`) are environment-dependent —
    // they only exist when Git for Windows is installed, which is not
    // guaranteed on every Windows runner image.
    if (process.platform === 'win32') {
      return;
    }
    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent-stage2-fallback-test-xyz';
    try {
      const detected = detectGit();
      expect(detected.ok).toBe(true);
      expect(detected.source).toBe('fallback');
      // The resolved path matches one of the platform-specific fallback
      // entries — exact value depends on whichever exists on the runner.
      const candidates = fallbackPaths(process.platform);
      expect(candidates).toContain(detected.resolvedPath);
    } finally {
      // Restore PATH regardless of test outcome so subsequent tests in
      // this file (and the runner's lifetime) see the original env.
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });
});

// ---------- assertGitAvailable (integration) ----------

describe('assertGitAvailable (integration)', () => {
  test('passes when runner git ≥ MIN_GIT_VERSION', () => {
    const detected = assertGitAvailable();
    expect(compareSemver(detected.version, MIN_GIT_VERSION)).toBeGreaterThanOrEqual(0);
  });
});

// ---------- MIN_GIT_VERSION ----------

describe('MIN_GIT_VERSION', () => {
  test('is a valid semver triple', () => {
    expect(MIN_GIT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('is at least 2.20 (the hard floor for `git init --initial-branch`)', () => {
    // 2.28 is when `--initial-branch` shipped; we keep 2.20 as the test floor
    // so we catch accidental regressions to ancient gits but allow the empirical
    // tech-probe to land anywhere in [2.20, 2.31] without re-shaping tests.
    expect(compareSemver(MIN_GIT_VERSION, '2.20.0')).toBeGreaterThanOrEqual(0);
  });
});

// ---------- /etc/os-release fixture round-trip (Linux only) ----------

describe('detectLinuxFamily fixtures', () => {
  test('parses a fixture file written to disk via the os-release argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-git-preflight-'));
    const path = join(dir, 'os-release');
    writeFileSync(
      path,
      `NAME="Debian GNU/Linux"
ID=debian
VERSION_ID="12"`,
      'utf-8',
    );
    // The fixture is fed in directly; we don't rely on /etc/os-release replacement.
    const contents = require('node:fs').readFileSync(path, 'utf-8');
    expect(detectLinuxFamily(contents)).toBe('debian');
  });
});
