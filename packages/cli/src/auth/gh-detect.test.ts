import { describe, expect, test } from 'vitest';
import type { ExecFileSyncFn } from './gh-detect.ts';
import { detectGh, detectGhAccounts } from './gh-detect.ts';

function makeExec(responses: Record<string, { token?: string; error?: NodeJS.ErrnoException }>): {
  exec: ExecFileSyncFn;
  calls: string[];
} {
  const calls: string[] = [];
  const exec = ((cmd: string, args: readonly string[]) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    const r = responses[cmd];
    if (!r) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    if (r.error) throw r.error;
    return r.token ?? '';
  }) as unknown as ExecFileSyncFn;
  return { exec, calls };
}

function makeScriptedGh(script: Record<string, string>): {
  exec: ExecFileSyncFn;
  calls: string[];
} {
  const calls: string[] = [];
  const exec = ((cmd: string, args: readonly string[]) => {
    const argv = `${cmd} ${args.join(' ')}`;
    calls.push(argv);
    const out = script[argv];
    if (out === undefined) throw new Error(`gh exited 1: ${argv}`);
    return out;
  }) as unknown as ExecFileSyncFn;
  return { exec, calls };
}

describe('detectGh', () => {
  test('returns available:true with token when bare `gh` works', () => {
    const { exec, calls } = makeExec({ gh: { token: 'ghu_abc123' } });
    const result = detectGh(undefined, { _exec: exec, _fileExists: () => false });
    expect(result).toEqual({ available: true, token: 'ghu_abc123' });
    expect(calls).toEqual(['gh auth token']);
  });

  test('passes --hostname when host is supplied', () => {
    const { exec, calls } = makeExec({ gh: { token: 'ghu_xyz' } });
    detectGh('github.acme.com', { _exec: exec, _fileExists: () => false });
    expect(calls[0]).toBe('gh auth token --hostname github.acme.com');
  });

  test('hides Windows console windows when probing gh auth token', () => {
    let seenOptions: unknown;
    const exec = ((_cmd: string, _args: readonly string[], options?: unknown) => {
      seenOptions = options;
      return 'ghu_hidden';
    }) as unknown as ExecFileSyncFn;

    const result = detectGh(undefined, { _exec: exec, _fileExists: () => false });

    expect(result).toEqual({ available: true, token: 'ghu_hidden' });
    expect(seenOptions).toMatchObject({
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    expect((seenOptions as { stdio?: unknown }).stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  test('returns available:false when bare gh and no known paths exist', () => {
    const { exec } = makeExec({});
    const result = detectGh(undefined, { _exec: exec, _fileExists: () => false });
    expect(result).toEqual({ available: false });
  });

  test('falls back to /opt/homebrew/bin/gh when bare `gh` ENOENTs (Electron PATH case)', () => {
    const { exec, calls } = makeExec({
      '/opt/homebrew/bin/gh': { token: 'ghu_homebrew' },
    });
    const result = detectGh(undefined, {
      _exec: exec,
      _fileExists: (p) => p === '/opt/homebrew/bin/gh',
    });
    expect(result).toEqual({ available: true, token: 'ghu_homebrew' });
    expect(calls).toEqual(['gh auth token', '/opt/homebrew/bin/gh auth token']);
  });

  test('skips absolute paths that do not exist on disk', () => {
    const { exec, calls } = makeExec({
      '/usr/local/bin/gh': { token: 'ghu_intel' },
    });
    const result = detectGh(undefined, {
      _exec: exec,
      _fileExists: (p) => p === '/usr/local/bin/gh',
    });
    expect(result).toEqual({ available: true, token: 'ghu_intel' });
    expect(calls).toEqual(['gh auth token', '/usr/local/bin/gh auth token']);
  });

  test('treats empty-string token from gh as unauthenticated and tries next candidate', () => {
    const { exec, calls } = makeExec({
      gh: { token: '   \n' },
      '/opt/homebrew/bin/gh': { token: 'ghu_real' },
    });
    const result = detectGh(undefined, {
      _exec: exec,
      _fileExists: (p) => p === '/opt/homebrew/bin/gh',
    });
    expect(result).toEqual({ available: true, token: 'ghu_real' });
    expect(calls).toHaveLength(2);
  });

  test('returns available:false when every candidate fails', () => {
    const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    const { exec } = makeExec({
      gh: { error: enoent },
      '/opt/homebrew/bin/gh': { error: enoent },
    });
    const result = detectGh(undefined, {
      _exec: exec,
      _fileExists: (p) => p === '/opt/homebrew/bin/gh',
    });
    expect(result).toEqual({ available: false });
  });
  test('requests a specific account with --user when a login is supplied', () => {
    const { exec, calls } = makeScriptedGh({
      'gh auth token --hostname github.com --user alice': 'gho_alice',
    });

    const result = detectGh('github.com', {
      login: 'alice',
      _exec: exec,
      _fileExists: () => false,
    });

    expect(result).toEqual({
      available: true,
      token: 'gho_alice',
      resolvedLogin: 'alice',
      fallback: false,
    });
    expect(calls).toEqual(['gh auth token --hostname github.com --user alice']);
  });
  test('falls back to the active account when the requested login has no token', () => {
    const { exec, calls } = makeScriptedGh({
      'gh auth token --hostname github.com': 'gho_active_bob',
    });

    const result = detectGh('github.com', {
      login: 'alice',
      _exec: exec,
      _fileExists: () => false,
    });

    expect(result).toEqual({ available: true, token: 'gho_active_bob', fallback: true });
    expect(calls).toEqual([
      'gh auth token --hostname github.com --user alice',
      'gh auth token --hostname github.com',
    ]);
  });

  test('falls back to the active account when gh is too old to know --user', () => {
    const calls: string[] = [];
    const exec = ((cmd: string, args: readonly string[]) => {
      const argv = `${cmd} ${args.join(' ')}`;
      calls.push(argv);
      if (args.includes('--user')) throw new Error('unknown flag: --user');
      return 'gho_active_bob';
    }) as unknown as ExecFileSyncFn;

    const result = detectGh('github.com', {
      login: 'alice',
      _exec: exec,
      _fileExists: () => false,
    });

    expect(result).toEqual({ available: true, token: 'gho_active_bob', fallback: true });
  });

  test('reports unavailable only when neither the requested login nor the active account answers', () => {
    const { exec, calls } = makeScriptedGh({});

    const result = detectGh('github.com', {
      login: 'alice',
      _exec: exec,
      _fileExists: () => false,
    });

    expect(result).toEqual({ available: false });
    expect(calls).toEqual([
      'gh auth token --hostname github.com --user alice',
      'gh auth token --hostname github.com',
    ]);
  });

  test('a login-scoped lookup still reaches gh at a known install path', () => {
    const { exec } = makeScriptedGh({
      '/opt/homebrew/bin/gh auth token --hostname github.com --user alice': 'gho_alice',
    });

    const result = detectGh('github.com', {
      login: 'alice',
      _exec: exec,
      _fileExists: (p) => p === '/opt/homebrew/bin/gh',
    });

    expect(result).toEqual({
      available: true,
      token: 'gho_alice',
      resolvedLogin: 'alice',
      fallback: false,
    });
  });
});

describe('detectGhAccounts', () => {
  test('lists each account for the host and marks the active one', () => {
    const { exec, calls } = makeScriptedGh({
      'gh auth status --hostname github.com --json hosts': JSON.stringify({
        hosts: {
          'github.com': [
            { state: 'success', active: true, host: 'github.com', login: 'bob' },
            { state: 'success', active: false, host: 'github.com', login: 'alice' },
          ],
        },
      }),
    });

    const accounts = detectGhAccounts('github.com', { _exec: exec, _fileExists: () => false });

    expect(accounts).toEqual([
      { login: 'bob', active: true },
      { login: 'alice', active: false },
    ]);
    expect(calls).toEqual(['gh auth status --hostname github.com --json hosts']);
  });

  test('parses the text listing when gh is too old to know --json', () => {
    const statusText = [
      'github.com',
      '  \u2713 Logged in to github.com account bob (keyring)',
      '  - Active account: true',
      "  - Token scopes: 'gist', 'read:org', 'repo'",
      '  \u2713 Logged in to github.com account alice (keyring)',
      '  - Active account: false',
      "  - Token scopes: 'repo'",
    ].join('\n');
    const { exec, calls } = makeScriptedGh({
      'gh auth status --hostname github.com': statusText,
    });

    const accounts = detectGhAccounts('github.com', { _exec: exec, _fileExists: () => false });

    expect(accounts).toEqual([
      { login: 'bob', active: true },
      { login: 'alice', active: false },
    ]);
    expect(calls).toEqual([
      'gh auth status --hostname github.com --json hosts',
      'gh auth status --hostname github.com',
    ]);
  });

  test('reports no list rather than guessing when gh cannot answer at all', () => {
    const { exec, calls } = makeScriptedGh({});

    const accounts = detectGhAccounts('github.com', { _exec: exec, _fileExists: () => false });

    expect(accounts).toBeUndefined();
    expect(calls).toEqual([
      'gh auth status --hostname github.com --json hosts',
      'gh auth status --hostname github.com',
    ]);
  });

  test.each([
    ['output that is not JSON at all', 'gh: unknown JSON fields: hosts'],
    ['a JSON payload with no hosts key', '{"unexpected": "shape"}'],
    ['a JSON payload whose host entries are not accounts', '{"hosts": {"github.com": "up"}}'],
  ])('drops to the text listing given %s', (_case, jsonOutput) => {
    const { exec } = makeScriptedGh({
      'gh auth status --hostname github.com --json hosts': jsonOutput,
      'gh auth status --hostname github.com':
        '  \u2713 Logged in to github.com account alice (keyring)\n  - Active account: true',
    });

    const accounts = detectGhAccounts('github.com', { _exec: exec, _fileExists: () => false });

    expect(accounts).toEqual([{ login: 'alice', active: true }]);
  });

  test('a multi-host JSON payload reads only the requested host', () => {
    const { exec } = makeScriptedGh({
      'gh auth status --hostname github.com --json hosts': JSON.stringify({
        hosts: {
          'ghes.corp.example': [{ state: 'success', active: true, login: 'work-bot' }],
          'github.com': [{ state: 'success', active: true, login: 'alice' }],
        },
      }),
    });

    const accounts = detectGhAccounts('github.com', { _exec: exec, _fileExists: () => false });

    expect(accounts).toEqual([{ login: 'alice', active: true }]);
  });

  test('a JSON payload that omits the requested host falls through to the text listing', () => {
    const { exec, calls } = makeScriptedGh({
      'gh auth status --hostname github.com --json hosts': JSON.stringify({
        hosts: {
          'ghes.corp.example': [{ state: 'success', active: true, login: 'work-bot' }],
        },
      }),
      'gh auth status --hostname github.com':
        '  \u2713 Logged in to github.com account alice (keyring)\n  - Active account: true',
    });

    const accounts = detectGhAccounts('github.com', { _exec: exec, _fileExists: () => false });

    expect(accounts).toEqual([{ login: 'alice', active: true }]);
    expect(calls).toEqual([
      'gh auth status --hostname github.com --json hosts',
      'gh auth status --hostname github.com',
    ]);
  });

  test('a host-omitting payload with no text listing either reports no list — never another host', () => {
    const { exec } = makeScriptedGh({
      'gh auth status --hostname github.com --json hosts': JSON.stringify({
        hosts: {
          'ghes.corp.example': [{ state: 'success', active: true, login: 'work-bot' }],
        },
      }),
    });

    const accounts = detectGhAccounts('github.com', { _exec: exec, _fileExists: () => false });

    expect(accounts).toBeUndefined();
  });

  test('a failed account\u2019s active flag does not attach to the previous healthy account', () => {
    const statusText = [
      'github.com',
      '  \u2713 Logged in to github.com account alice (keyring)',
      '  - Active account: false',
      '  - Git operations protocol: https',
      '  X Failed to log in to github.com account bob (keyring)',
      '  - Active account: true',
      '  - The token in keyring is invalid.',
    ].join('\n');
    const { exec } = makeScriptedGh({
      'gh auth status --hostname github.com': statusText,
    });

    const accounts = detectGhAccounts('github.com', { _exec: exec, _fileExists: () => false });

    expect(accounts).toEqual([{ login: 'alice', active: false }]);
  });

  test('a timed-out account\u2019s detail lines are dropped the same way', () => {
    const statusText = [
      'github.com',
      '  \u2713 Logged in to github.com account alice (keyring)',
      '  - Active account: false',
      '  X Timeout trying to log in to github.com account bob (keyring)',
      '  - Active account: true',
    ].join('\n');
    const { exec } = makeScriptedGh({
      'gh auth status --hostname github.com': statusText,
    });

    const accounts = detectGhAccounts('github.com', { _exec: exec, _fileExists: () => false });

    expect(accounts).toEqual([{ login: 'alice', active: false }]);
  });

  test('forced-color output still parses — ANSI codes never reach the login', () => {
    const bold = (s: string) => `\u001b[1m${s}\u001b[0m`;
    const statusText = [
      'github.com',
      `  ✓ Logged in to github.com account ${bold('alice')} (keyring)`,
      '  - Active account: true',
    ].join('\n');
    const { exec } = makeScriptedGh({
      'gh auth status --hostname github.com': statusText,
    });

    const accounts = detectGhAccounts('github.com', { _exec: exec, _fileExists: () => false });

    expect(accounts).toEqual([{ login: 'alice', active: true }]);
  });
});
