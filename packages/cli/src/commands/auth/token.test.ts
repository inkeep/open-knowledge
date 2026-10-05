import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { isGitHubHost } from '@inkeep/open-knowledge-core';
import password from '@inquirer/password';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FileBackend } from '../../auth/token-store.ts';
import { readTokenFromStdin } from './read-token-stdin.ts';
import { runTokenPaste, tokenCommand } from './token.ts';

vi.mock('@inquirer/password', () => ({
  default: vi.fn(async () => {
    throw new Error('the interactive prompt was opened');
  }),
}));

function makeStore(tmpDir: string) {
  return new FileBackend(join(tmpDir, 'auth.yml'));
}

function constantToken(token: string): () => Promise<string> {
  return async () => token;
}

describe('runTokenPaste', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-auth-token-'));
    vi.stubEnv('HOME', tmpDir);
    vi.stubEnv('USERPROFILE', tmpDir);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('stores login and token for an arbitrary git host without calling out to a network', async () => {
    const store = makeStore(tmpDir);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await runTokenPaste(
      { host: 'gitea.internal', username: 'alice', json: false },
      store,
      constantToken('gitea_token_abc'),
    );

    expect(result).toEqual({ type: 'complete', host: 'gitea.internal', login: 'alice' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await store.get('gitea.internal')).toMatchObject({
      login: 'alice',
      token: 'gitea_token_abc',
      gitProtocol: 'https',
    });
  });

  test.each([
    ['Gitea.Internal', 'gitea.internal'],
    ['gitea.internal:443', 'gitea.internal'],
    ['Gitea.Internal:8443', 'gitea.internal:8443'],
  ])('stores %s under the key git asks for, %s', async (typed, key) => {
    const store = makeStore(tmpDir);

    const result = await runTokenPaste(
      { host: typed, username: 'alice', json: false },
      store,
      constantToken('gitea_token_abc'),
    );

    expect(result).toEqual({ type: 'complete', host: key, login: 'alice' });
    expect(await store.get(key)).toMatchObject({ login: 'alice', token: 'gitea_token_abc' });
  });

  test('accepts a host that is not a GitHub host, which ok auth pat refuses', async () => {
    const store = makeStore(tmpDir);
    expect(isGitHubHost('gitlab.com')).toBe(false);

    const result = await runTokenPaste(
      { host: 'gitlab.com', username: 'oauth2', json: false },
      store,
      constantToken('glpat_xyz'),
    );

    expect(result).toEqual({ type: 'complete', host: 'gitlab.com', login: 'oauth2' });
    expect(await store.get('gitlab.com')).toMatchObject({ login: 'oauth2', token: 'glpat_xyz' });
  });

  test('the --token-stdin reader takes the token from the stdin stream and drops its trailing newline', async () => {
    const store = makeStore(tmpDir);
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: Readable.from([Buffer.from('gitea_from_stdin\n', 'utf8')]),
    });

    try {
      const result = await runTokenPaste(
        { host: 'gitea.internal', username: 'alice', json: false },
        store,
        readTokenFromStdin,
      );
      expect(result.type).toBe('complete');
    } finally {
      if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
    }

    expect(await store.get('gitea.internal')).toMatchObject({ token: 'gitea_from_stdin' });
  });

  test('--json writes one complete line carrying the host and login to stdout', async () => {
    const store = makeStore(tmpDir);
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    });

    const result = await runTokenPaste(
      { host: 'bitbucket.org', username: 'x-bitbucket-api-token-auth', json: true },
      store,
      constantToken('bb_token'),
    );

    expect(result).toEqual({
      type: 'complete',
      host: 'bitbucket.org',
      login: 'x-bitbucket-api-token-auth',
    });
    expect(stdout).toBe(
      '{"type":"complete","host":"bitbucket.org","login":"x-bitbucket-api-token-auth"}\n',
    );
  });

  test('a missing or whitespace-only --username is rejected and writes nothing to the store', async () => {
    const store = makeStore(tmpDir);

    const missing = await runTokenPaste(
      { host: 'gitea.internal', json: false },
      store,
      constantToken('tok'),
    );
    const blank = await runTokenPaste(
      { host: 'gitea.internal', username: '   ', json: false },
      store,
      constantToken('tok'),
    );

    expect(missing.type).toBe('error');
    expect(blank.type).toBe('error');
    expect(await store.get('gitea.internal')).toBeNull();
  });

  test('a missing --host is rejected rather than defaulted from the workspace origin', async () => {
    const store = makeStore(tmpDir);

    const result = await runTokenPaste(
      { username: 'alice', json: false },
      store,
      constantToken('tok'),
    );

    expect(result.type).toBe('error');
    expect(await store.get('github.com')).toBeNull();
  });

  test('an empty token is rejected and writes nothing to the store', async () => {
    const store = makeStore(tmpDir);

    const result = await runTokenPaste(
      { host: 'gitea.internal', username: 'alice', json: false },
      store,
      constantToken(''),
    );

    expect(result.type).toBe('error');
    expect(await store.get('gitea.internal')).toBeNull();
  });

  test('clearing the host on this backend removes the stored entry, which is the FileBackend half of signout and not its fan-out across backends', async () => {
    const store = makeStore(tmpDir);
    await runTokenPaste(
      { host: 'gitea.internal', username: 'alice', json: false },
      store,
      constantToken('tok'),
    );
    expect(await store.get('gitea.internal')).not.toBeNull();

    await store.clear('gitea.internal');

    expect(await store.get('gitea.internal')).toBeNull();
  });

  test.each([
    'https://gitea.internal',
    'gitea.internal/team/wiki',
    'gitea.internal/',
    'alice@gitea.internal',
    'gitea.internal:port',
  ])('a host git would never send (%s) is rejected and writes nothing', async (host) => {
    const store = makeStore(tmpDir);
    const result = await runTokenPaste(
      { host, username: 'alice', json: false },
      store,
      constantToken('tok'),
    );
    expect(result).toMatchObject({ type: 'error', message: expect.stringContaining('host name') });
    expect(await store.get(host)).toBeNull();
  });

  test('a host with a port is stored under the host and port git sends', async () => {
    const store = makeStore(tmpDir);
    const result = await runTokenPaste(
      { host: 'gitea.internal:8443', username: 'alice', json: false },
      store,
      constantToken('tok'),
    );
    expect(result.type).toBe('complete');
    expect(await store.get('gitea.internal:8443')).toMatchObject({ login: 'alice' });
  });

  test('a GitHub host is refused and pointed at ok auth pat, leaving the verified entry alone', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'octocat', 'verified', { gitProtocol: 'https' });
    const result = await runTokenPaste(
      { host: 'github.com', username: 'mallory', json: false },
      store,
      constantToken('unverified'),
    );
    expect(result).toMatchObject({
      type: 'error',
      message: expect.stringContaining('ok auth pat --host github.com'),
    });
    expect(await store.get('github.com')).toMatchObject({ login: 'octocat', token: 'verified' });
  });

  test('a credential store that refuses the write reports a structured error', async () => {
    const store = makeStore(tmpDir);
    vi.spyOn(store, 'set').mockRejectedValue(new Error('keychain locked'));
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const result = await runTokenPaste(
      { host: 'gitea.internal', username: 'alice', json: true },
      store,
      constantToken('tok'),
    );
    expect(result).toMatchObject({
      type: 'error',
      message: expect.stringContaining('keychain locked'),
    });
    expect(JSON.parse(stdout)).toMatchObject({ type: 'error' });
  });
});

describe('tokenCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-auth-token-command-'));
    vi.stubEnv('HOME', tmpDir);
    vi.stubEnv('USERPROFILE', tmpDir);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('--token-stdin reads the token from stdin and never opens the interactive prompt', async () => {
    const store = makeStore(tmpDir);
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: Readable.from([Buffer.from('piped_token\n', 'utf8')]),
    });
    try {
      await tokenCommand(async () => store).parseAsync(
        ['--host', 'gitea.internal', '--username', 'alice', '--token-stdin', '--json'],
        { from: 'user' },
      );
    } finally {
      if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
    }
    expect(password).not.toHaveBeenCalled();
    expect(await store.get('gitea.internal')).toMatchObject({
      login: 'alice',
      token: 'piped_token',
    });
  });
});
