import { describe, expect, test } from 'vitest';
import { runAuthReposSubprocess, runAuthStatusSubprocess } from './auth-query.ts';

const fixtureCli = (script: string): readonly string[] => [process.execPath, '-e', script];

describe('runAuthStatusSubprocess', () => {
  test('parses an authenticated status emission', async () => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'status', host:'github.com', authenticated:true, login:'octocat', name:'Octo Cat', email:'octo@github.com'}));
      `),
    });
    expect(result).toEqual({
      authenticated: true,
      host: 'github.com',
      login: 'octocat',
      name: 'Octo Cat',
      email: 'octo@github.com',
    });
  });

  test('parses an unauthenticated status emission (CLI exits 1, JSON still on stdout)', async () => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'status', host:'github.com', authenticated:false}));
        process.exit(1);
      `),
    });
    expect(result).toEqual({
      authenticated: false,
      host: 'github.com',
      error: undefined,
    });
  });

  test('forwards an "error" field on unauthenticated emissions (e.g. token invalid)', async () => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'status', host:'github.com', authenticated:false, error:'token invalid'}));
        process.exit(1);
      `),
    });
    expect(result).toEqual({
      authenticated: false,
      host: 'github.com',
      error: 'token invalid',
    });
  });

  test('ignores non-status JSON lines, picks up the status one (older builds emit keychain probes)', async () => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'keychain-probe', backend:'darwin'}));
        console.log(JSON.stringify({type:'status', host:'github.com', authenticated:true, login:'octocat'}));
      `),
    });
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.login).toBe('octocat');
    }
  });

  test('returns unauthenticated when no status line is emitted on clean exit', async () => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`process.exit(0)`),
    });
    expect(result).toEqual({
      authenticated: false,
      host: 'github.com',
      error: undefined,
    });
  });

  test('surfaces stderr in error when CLI exits non-zero without a status line', async () => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write('bun: command not found: open-knowledge\\n');
        process.exit(127);
      `),
    });
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.error).toContain('command not found');
    }
  });

  test('falls back to exit-code message when CLI exits non-zero without stderr', async () => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`process.exit(2)`),
    });
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.error).toContain('exited with code 2');
    }
  });

  test('redacts a bare PAT out of the status error before it is persisted', async () => {
    const token = `ghp_${'c'.repeat(36)}`;
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write("[auth] Failed to parse auth.yml: bad indentation at line 2:\\n  token: ${token}\\n");
        process.exit(1);
      `),
    });
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.error).not.toContain(token);
      expect(result.error).toContain('[REDACTED-GH-PAT]');
    }
  });

  test('caps an overlong status stderr at the shared detail cap', async () => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write('x'.repeat(3000));
        process.exit(1);
      `),
    });
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.error?.length).toBe(500);
    }
  });

  test('reports a timeout-marker error when the subprocess hangs past timeoutMs', async () => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
      timeoutMs: 100,
    });
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.error).toMatch(/timed out/i);
    }
  });

  test.each(['A', 'B', 'C'] as const)('forwards tier %s through the parser', async (tier) => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'status', host:'github.com', authenticated:true, tier:'${tier}', login:'octocat'}));
      `),
    });
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.tier).toBe(tier);
    }
  });

  test('drops an unknown tier value (forward-compat: future tiers are ignored, not crashed)', async () => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'status', host:'github.com', authenticated:true, tier:'Z', login:'octocat'}));
      `),
    });
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.tier).toBeUndefined();
    }
  });

  test('forwards cliEnv through to the spawned CLI', async () => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'status', host:'github.com', authenticated:true, login: process.env.OK_AUTH_STATUS_ENV_MARKER || 'unset'}));
      `),
      cliEnv: { OK_AUTH_STATUS_ENV_MARKER: 'marker-from-cli-env' },
    });
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.login).toBe('marker-from-cli-env');
    }
  });

  test('uses a custom host when provided', async () => {
    const result = await runAuthStatusSubprocess({
      cliArgs: fixtureCli(`
        // Echo the --host arg back to verify it was passed through.
        const host = process.argv[process.argv.indexOf('--host') + 1];
        console.log(JSON.stringify({type:'status', host, authenticated:false}));
      `),
      host: 'ghe.example.com',
    });
    expect(result.host).toBe('ghe.example.com');
  });
});

describe('runAuthReposSubprocess', () => {
  test('parses a bounded repos response', async () => {
    const result = await runAuthReposSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'repos', host:'github.com', repos:[
          {full_name:'octo/repo1', clone_url:'https://github.com/octo/repo1.git', private:false},
          {full_name:'octo/repo2', clone_url:'https://github.com/octo/repo2.git', private:true},
        ]}));
      `),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.host).toBe('github.com');
      expect(result.repos).toHaveLength(2);
      expect(result.repos[0]).toEqual({
        full_name: 'octo/repo1',
        clone_url: 'https://github.com/octo/repo1.git',
        private: false,
      });
      expect(result.repos[1].private).toBe(true);
    }
  });

  test('drops malformed repo entries but keeps valid ones', async () => {
    const result = await runAuthReposSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'repos', host:'github.com', repos:[
          {full_name:'good/one', clone_url:'https://github.com/good/one.git', private:false},
          {missing:'fields'},
          {full_name:42, clone_url:'wrong-type', private:false},
          {full_name:'good/two', clone_url:'https://github.com/good/two.git'},
        ]}));
      `),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repos.map((r) => r.full_name)).toEqual(['good/one', 'good/two']);
      expect(result.repos[1].private).toBe(false);
    }
  });

  test('returns an error when the CLI exits nonzero (e.g. not signed in)', async () => {
    const result = await runAuthReposSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write('Not logged in to github.com\\n');
        process.exit(1);
      `),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Not logged in');
    }
  });

  test('flags the signed-out CLI exit as unauthenticated, not a command failure', async () => {
    const result = await runAuthReposSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write('[auth] token storage: OS keychain\\nNot logged in to github.com\\n');
        process.exit(1);
      `),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Not logged in to github.com');
    }
  });

  test.each([
    ['a bare signed-out sentence', 'Not logged in to github.com\\n'],
    [
      'a file-backend storage banner ahead of the signed-out sentence',
      '[auth] token storage: file (~/.ok/auth.yml) — OS keychain unavailable: keyring init failed\\nNot logged in to github.com\\n',
    ],
  ])('still flags %s as unauthenticated', async (_label, stderr) => {
    const result = await runAuthReposSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write('${stderr}');
        process.exit(1);
      `),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Not logged in to github.com');
    }
  });

  test('an auth.yml parse error beside the signed-out sentence stays a loggable failure', async () => {
    const result = await runAuthReposSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write('[auth] token storage: file (~/.ok/auth.yml) — OS keychain unavailable: keyring init failed\\n[auth] Failed to parse ~/.ok/auth.yml: bad indentation at line 2. Starting with empty credentials.\\nNot logged in to github.com\\n');
        process.exit(1);
      `),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.authenticated).toBeUndefined();
      expect(result.error).toContain('Failed to parse ~/.ok/auth.yml');
    }
  });

  test('a genuine command failure carries no unauthenticated flag', async () => {
    const result = await runAuthReposSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write('spawn EINVAL\\n');
        process.exit(1);
      `),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.authenticated).toBeUndefined();
      expect(result.error).toContain('spawn EINVAL');
    }
  });

  test('redacts a bare PAT out of the repos error before it is persisted', async () => {
    const token = `ghp_${'d'.repeat(36)}`;
    const result = await runAuthReposSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write("[auth] Failed to parse auth.yml: bad indentation at line 2:\\n  token: ${token}\\n");
        process.exit(1);
      `),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(token);
      expect(result.error).toContain('[REDACTED-GH-PAT]');
    }
  });

  test('caps an overlong repos stderr at the shared detail cap', async () => {
    const result = await runAuthReposSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write('x'.repeat(3000));
        process.exit(1);
      `),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBe(500);
    }
  });

  test('returns an error when the CLI emits no repos line on clean exit', async () => {
    const result = await runAuthReposSubprocess({
      cliArgs: fixtureCli(`process.exit(0)`),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('no data');
    }
  });

  test('reports timeout error when the subprocess hangs', async () => {
    const result = await runAuthReposSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/timed out/i);
    }
  });

  test('forwards cliEnv through to the spawned CLI', async () => {
    const result = await runAuthReposSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'repos', host:'github.com', repos:[
          {full_name: process.env.OK_AUTH_REPOS_ENV_MARKER || 'unset', clone_url:'https://github.com/octo/repo1.git', private:false},
        ]}));
      `),
      cliEnv: { OK_AUTH_REPOS_ENV_MARKER: 'marker/from-cli-env' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repos.map((r) => r.full_name)).toEqual(['marker/from-cli-env']);
    }
  });
});
