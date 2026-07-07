/**
 * One-shot auth query runners — `auth status` and `auth repos`.
 *
 * Both spawn the CLI via `process.execPath -e <script>` for deterministic
 * testing without depending on the project CLI being installed.
 */
import { describe, expect, test } from 'bun:test';
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
});
