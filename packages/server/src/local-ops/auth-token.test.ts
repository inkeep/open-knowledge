import { describe, expect, test } from 'vitest';
import { runAuthTokenSubprocess } from './auth-token.ts';

const fixtureCli = (script: string): readonly string[] => [process.execPath, '-e', script];

const ECHO_STDIN_CLI = `
let d='';
process.stdin.on('data', c => { d += c; });
process.stdin.on('end', () => {
  if (d.trim() === 'good-token') {
    process.stdout.write(JSON.stringify({ type: 'complete', host: 'ghes.test', login: 'got:' + d.trim() }) + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ type: 'error', message: 'Could not store the token for ghes.test' }) + '\\n');
  process.exit(1);
});
`;

const ECHO_ARGV_CLI = `
let d='';
process.stdin.on('data', c => { d += c; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'complete', host: 'ghes.test', login: JSON.stringify(process.argv) }) + '\\n');
  process.exit(0);
});
`;

describe('runAuthTokenSubprocess', () => {
  test('feeds the token via stdin and returns the stored identity on complete', async () => {
    const result = await runAuthTokenSubprocess({
      cliArgs: fixtureCli(ECHO_STDIN_CLI),
      host: 'ghes.test',
      username: 'alice',
      token: 'good-token',
    });
    expect(result).toEqual({ ok: true, host: 'ghes.test', login: 'got:good-token' });
  });

  test('surfaces the CLI error message when the store fails', async () => {
    const result = await runAuthTokenSubprocess({
      cliArgs: fixtureCli(ECHO_STDIN_CLI),
      host: 'ghes.test',
      username: 'alice',
      token: 'wrong-token',
    });
    expect(result).toEqual({
      ok: false,
      host: 'ghes.test',
      error: 'Could not store the token for ghes.test',
    });
  });

  test('falls back to a bounded generic error when the child exits with no terminal event', async () => {
    const result = await runAuthTokenSubprocess({
      cliArgs: fixtureCli('process.exit(3)'),
      host: 'ghes.test',
      username: 'alice',
      token: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Storing the token failed.');
    }
  });

  test('folds the child stderr into the generic fallback error', async () => {
    const result = await runAuthTokenSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write('spawn EINVAL');
        process.exitCode = 3;
      `),
      host: 'ghes.test',
      username: 'alice',
      token: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Storing the token failed.');
      expect(result.error).toContain('spawn EINVAL');
    }
  });

  test('keeps the token out of the child argv while passing the username through', async () => {
    const token = 'argv-must-not-carry-this-token';
    const result = await runAuthTokenSubprocess({
      cliArgs: fixtureCli(ECHO_ARGV_CLI),
      host: 'ghes.test',
      username: 'alice',
      token,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const argv = JSON.parse(result.login) as string[];
    expect(argv).not.toContain(token);
    expect(argv.join(' ')).not.toContain(token);
    expect(argv).toContain('--username');
    expect(argv).toContain('alice');
    expect(argv).toContain('--token-stdin');
    expect(argv).toContain('--host');
    expect(argv).toContain('ghes.test');
  });

  test('redacts credentialed stderr before it reaches the fallback error', async () => {
    const token = `ghp_${'b'.repeat(36)}`;
    const result = await runAuthTokenSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write("fatal: unable to access 'https://x-access-token:${token}@ghes.test/o/r.git/'");
        process.exitCode = 3;
      `),
      host: 'ghes.test',
      username: 'alice',
      token,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(token);
      expect(result.error).toContain('https://[REDACTED]@ghes.test');
    }
  });

  test('redacts a bare PAT in stderr other than the submitted token', async () => {
    const storedToken = `ghp_${'g'.repeat(36)}`;
    const result = await runAuthTokenSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write("[auth] Failed to parse auth.yml: bad indentation at line 2:\\n  token: ${storedToken}");
        process.exitCode = 3;
      `),
      host: 'ghes.test',
      username: 'alice',
      token: 'submitted-token',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(storedToken);
      expect(result.error).toContain('[REDACTED-GH-PAT]');
    }
  });

  test('removes the submitted token from stderr even when no scrubber pattern knows its shape', async () => {
    const token = `${'a'.repeat(8)}0123456789abcdef0123456789abcdef`;
    const result = await runAuthTokenSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write("[auth] Failed to parse auth.yml: bad indentation at line 2:\\n  token: ${token}");
        process.exitCode = 3;
      `),
      host: 'gitea.internal',
      username: 'alice',
      token: `${token}\n`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(token);
      expect(result.error).toContain('token: [REDACTED]');
    }
  });

  test('forwards cliEnv through to the spawned CLI', async () => {
    const result = await runAuthTokenSubprocess({
      cliArgs: fixtureCli(`
        let d='';
        process.stdin.on('data', c => { d += c; });
        process.stdin.on('end', () => {
          process.stdout.write(JSON.stringify({ type: 'complete', host: 'ghes.test', login: process.env.OK_AUTH_TOKEN_ENV_MARKER || 'unset' }) + '\\n');
          process.exit(0);
        });
      `),
      cliEnv: { OK_AUTH_TOKEN_ENV_MARKER: 'marker-from-cli-env' },
      host: 'ghes.test',
      username: 'alice',
      token: 'good-token',
    });
    expect(result).toEqual({ ok: true, host: 'ghes.test', login: 'marker-from-cli-env' });
  });
});
