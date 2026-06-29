
import { describe, expect, test } from 'bun:test';
import {
  isValidShareOwnerName,
  isValidShareRepoName,
  parseNameCheckEvent,
  parseOwnersEvent,
  parsePublishEvent,
  pickTerminalJsonLine,
  redactShareSubprocessStderr,
} from './publish.ts';

describe('isValidShareRepoName', () => {
  test('accepts allowed shapes', () => {
    expect(isValidShareRepoName('foo')).toBe(true);
    expect(isValidShareRepoName('foo-bar')).toBe(true);
    expect(isValidShareRepoName('foo_bar.baz')).toBe(true);
    expect(isValidShareRepoName('A')).toBe(true);
    expect(isValidShareRepoName('a'.repeat(100))).toBe(true);
  });
  test('rejects forbidden shapes', () => {
    expect(isValidShareRepoName('')).toBe(false);
    expect(isValidShareRepoName('.hidden')).toBe(false);
    expect(isValidShareRepoName('-leading')).toBe(false);
    expect(isValidShareRepoName('---')).toBe(false);
    expect(isValidShareRepoName('with spaces')).toBe(false);
    expect(isValidShareRepoName('with/slash')).toBe(false);
    expect(isValidShareRepoName('a'.repeat(101))).toBe(false);
  });
});

describe('isValidShareOwnerName', () => {
  test('accepts allowed shapes', () => {
    expect(isValidShareOwnerName('alice')).toBe(true);
    expect(isValidShareOwnerName('inkeep')).toBe(true);
    expect(isValidShareOwnerName('a-b-c')).toBe(true);
    expect(isValidShareOwnerName('a'.repeat(39))).toBe(true);
  });
  test('rejects forbidden shapes', () => {
    expect(isValidShareOwnerName('')).toBe(false);
    expect(isValidShareOwnerName('-alice')).toBe(false);
    expect(isValidShareOwnerName('alice-')).toBe(false);
    expect(isValidShareOwnerName('with.dot')).toBe(false);
    expect(isValidShareOwnerName('with/slash')).toBe(false);
    expect(isValidShareOwnerName('a'.repeat(40))).toBe(false);
  });
});

describe('pickTerminalJsonLine', () => {
  test('returns the last parseable JSON line', () => {
    const stdout = '[probe] keyring: ok\n{"type":"owners","owners":[]}\n';
    const out = pickTerminalJsonLine(stdout);
    expect(out).toEqual({ type: 'owners', owners: [] });
  });
  test('skips non-JSON trailing lines', () => {
    const stdout = '{"type":"owners","owners":[]}\nrandom noise\n';
    const out = pickTerminalJsonLine(stdout);
    expect(out).toEqual({ type: 'owners', owners: [] });
  });
  test('returns null when no JSON line exists', () => {
    expect(pickTerminalJsonLine('garbage')).toBeNull();
    expect(pickTerminalJsonLine('')).toBeNull();
  });
  test('arrays are not picked up (event shape is object)', () => {
    expect(pickTerminalJsonLine('[1,2,3]')).toBeNull();
  });
});

describe('parseOwnersEvent', () => {
  test('happy path returns owners array', () => {
    const result = parseOwnersEvent({
      type: 'owners',
      owners: [
        { login: 'alice', kind: 'user', avatarUrl: 'a' },
        { login: 'inkeep', kind: 'org' },
      ],
    });
    expect(result).toEqual({
      ok: true,
      owners: [
        { login: 'alice', kind: 'user', avatarUrl: 'a' },
        { login: 'inkeep', kind: 'org' },
      ],
    });
  });
  test('drops owners with missing login or kind', () => {
    const result = parseOwnersEvent({
      type: 'owners',
      owners: [
        { login: 'alice', kind: 'user' },
        { kind: 'org' },
        { login: 'inkeep', kind: 'invalid' },
      ],
    });
    expect(result).toEqual({ ok: true, owners: [{ login: 'alice', kind: 'user' }] });
  });
  test('error events surface auth-required', () => {
    const result = parseOwnersEvent({ type: 'error', code: 'auth-required' });
    expect(result).toEqual({ ok: false, error: 'auth-required' });
  });
  test('error events surface network', () => {
    const result = parseOwnersEvent({ type: 'error', code: 'network' });
    expect(result).toEqual({ ok: false, error: 'network' });
  });
  test('unknown error code → network', () => {
    const result = parseOwnersEvent({ type: 'error', code: 'mystery' });
    expect(result).toEqual({ ok: false, error: 'network' });
  });
  test('unrecognized event type → network', () => {
    const result = parseOwnersEvent({ type: 'wat' });
    expect(result).toEqual({ ok: false, error: 'network' });
  });
  test('null event → network (subprocess emitted no JSON)', () => {
    expect(parseOwnersEvent(null)).toEqual({ ok: false, error: 'network' });
  });
});

describe('parseNameCheckEvent', () => {
  test('happy path: available true', () => {
    const result = parseNameCheckEvent({ type: 'name-check', available: true });
    expect(result).toEqual({ ok: true, available: true });
  });
  test('happy path: available false', () => {
    const result = parseNameCheckEvent({ type: 'name-check', available: false });
    expect(result).toEqual({ ok: true, available: false });
  });
  test('available missing → network', () => {
    const result = parseNameCheckEvent({ type: 'name-check' });
    expect(result).toEqual({ ok: false, error: 'network' });
  });
  test('error event surfaces auth-required', () => {
    const result = parseNameCheckEvent({ type: 'error', code: 'auth-required' });
    expect(result).toEqual({ ok: false, error: 'auth-required' });
  });
});

describe('parsePublishEvent', () => {
  test('happy path returns full success body', () => {
    const result = parsePublishEvent({
      type: 'publish',
      ownerLogin: 'alice',
      repoName: 'demo',
      cloneUrl: 'https://github.com/alice/demo.git',
      defaultBranch: 'main',
    });
    expect(result).toEqual({
      ok: true,
      ownerLogin: 'alice',
      repoName: 'demo',
      cloneUrl: 'https://github.com/alice/demo.git',
      defaultBranch: 'main',
    });
  });
  test('missing field → network', () => {
    const result = parsePublishEvent({
      type: 'publish',
      ownerLogin: 'alice',
      cloneUrl: 'https://github.com/alice/demo.git',
      defaultBranch: 'main',
    });
    expect(result).toEqual({ ok: false, error: 'network' });
  });
  test('name-conflict propagates', () => {
    const result = parsePublishEvent({ type: 'error', code: 'name-conflict' });
    expect(result).toEqual({ ok: false, error: 'name-conflict' });
  });
  test('saml-sso propagates', () => {
    const result = parsePublishEvent({ type: 'error', code: 'saml-sso' });
    expect(result).toEqual({ ok: false, error: 'saml-sso' });
  });
  test('all five publish error codes round-trip', () => {
    for (const code of [
      'name-conflict',
      'saml-sso',
      'auth-required',
      'push-failed',
      'init-failed',
      'no-project',
    ] as const) {
      const result = parsePublishEvent({ type: 'error', code });
      expect(result).toEqual({ ok: false, error: code });
    }
  });
  test('unknown error code → network', () => {
    const result = parsePublishEvent({ type: 'error', code: 'mystery' });
    expect(result).toEqual({ ok: false, error: 'network' });
  });
});

describe('redactShareSubprocessStderr', () => {
  test('redacts x-access-token PAT in inline-token URL', () => {
    const stderr =
      'remote: Repository not found.\nfatal: unable to access https://x-access-token:ghp_abc123XYZ@github.com/inkeep/repo.git/';
    const redacted = redactShareSubprocessStderr(stderr);
    expect(redacted).toContain('x-access-token:***@github.com');
    expect(redacted).not.toContain('ghp_abc123XYZ');
  });

  test('redacts bare basic-auth credentials in URLs', () => {
    const stderr = 'curl: (22) https://user:s3cret@github.com/owner/repo';
    const redacted = redactShareSubprocessStderr(stderr);
    expect(redacted).toContain('user:***@github.com');
    expect(redacted).not.toContain('s3cret');
  });

  test('passes through stderr with no credentials unchanged', () => {
    const stderr = 'error: keyring not available\n';
    expect(redactShareSubprocessStderr(stderr)).toBe(stderr);
  });

  test('handles empty input', () => {
    expect(redactShareSubprocessStderr('')).toBe('');
  });
});
