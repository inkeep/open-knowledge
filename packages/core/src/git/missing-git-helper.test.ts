import { describe, expect, test } from 'bun:test';
import { detectMissingGitHelper } from './missing-git-helper.ts';

describe('detectMissingGitHelper', () => {
  // The incident stderr, verbatim: packaged desktop spawned git with launchd's
  // minimal PATH, git-lfs (Homebrew-installed) unresolvable at checkout.
  test('extracts git-lfs from the lfs filter-process failure', () => {
    const stderr =
      'git-lfs filter-process: git-lfs: command not found\nfatal: the remote end hung up unexpectedly';
    expect(detectMissingGitHelper(stderr)).toBe('git-lfs');
  });

  test('extracts the command from bash 127 phrasing', () => {
    expect(detectMissingGitHelper('sh: gpg: command not found')).toBe('gpg');
  });

  test('extracts the command from dash 127 phrasing (Linux /bin/sh)', () => {
    expect(detectMissingGitHelper('sh: 1: git-lfs: not found')).toBe('git-lfs');
  });

  test("extracts the command from git's start_command failure", () => {
    expect(detectMissingGitHelper('error: cannot run gpg: No such file or directory')).toBe('gpg');
    expect(detectMissingGitHelper('fatal: cannot run ssh: No such file or directory')).toBe('ssh');
  });

  test('extracts the hook path from a cannot-exec failure', () => {
    expect(
      detectMissingGitHelper(
        "fatal: cannot exec '.husky/post-checkout': No such file or directory",
      ),
    ).toBe('.husky/post-checkout');
  });

  test('extracts a credential helper dispatched through the git namespace', () => {
    expect(
      detectMissingGitHelper("git: 'credential-manager' is not a git command. See 'git --help'."),
    ).toBe('credential-manager');
  });

  test('returns null for non-helper git failures', () => {
    expect(detectMissingGitHelper("fatal: 'dev' is already checked out at '/tmp/x'")).toBeNull();
    expect(detectMissingGitHelper("fatal: a branch named 'dev' already exists")).toBeNull();
    expect(detectMissingGitHelper("fatal: couldn't find remote ref refs/heads/gone")).toBeNull();
    expect(detectMissingGitHelper('fatal: not a git repository')).toBeNull();
    expect(detectMissingGitHelper('')).toBeNull();
  });

  // "ref not found"-style prose has no colon directly before the phrase, so
  // the shell-127 pattern must not fire on it.
  test('does not misread prose containing "not found" without a command colon', () => {
    expect(detectMissingGitHelper('fatal: remote ref not found')).toBeNull();
  });
});
