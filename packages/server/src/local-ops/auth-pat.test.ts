import { describe, expect, test } from 'vitest';
import { runPatSubprocess } from './auth-pat.ts';

const fixtureCli = (script: string): readonly string[] => [process.execPath, '-e', script];

const ECHO_STDIN_CLI = `
let d='';
process.stdin.on('data', c => { d += c; });
process.stdin.on('end', () => {
  if (d.trim() === 'good-token') {
    process.stdout.write(JSON.stringify({ type: 'complete', host: 'ghes.test', login: 'got:' + d.trim() }) + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ type: 'error', message: 'Token invalid for ghes.test' }) + '\\n');
  process.exit(1);
});
`;

describe('runPatSubprocess', () => {
  test('feeds the token via stdin and returns the stored identity on complete', async () => {
    const result = await runPatSubprocess({
      cliArgs: fixtureCli(ECHO_STDIN_CLI),
      host: 'ghes.test',
      token: 'good-token',
    });
    expect(result).toEqual({ ok: true, host: 'ghes.test', login: 'got:good-token' });
  });

  test('surfaces the CLI error message on a rejected token', async () => {
    const result = await runPatSubprocess({
      cliArgs: fixtureCli(ECHO_STDIN_CLI),
      host: 'ghes.test',
      token: 'wrong-token',
    });
    expect(result).toEqual({ ok: false, host: 'ghes.test', error: 'Token invalid for ghes.test' });
  });

  test('falls back to a bounded generic error when the child exits with no terminal event', async () => {
    const result = await runPatSubprocess({
      cliArgs: fixtureCli('process.exit(3)'),
      host: 'ghes.test',
      token: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Token validation failed.');
    }
  });

  test('folds the child stderr into the generic fallback error', async () => {
    const result = await runPatSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write('spawn EINVAL');
        process.exitCode = 3;
      `),
      host: 'ghes.test',
      token: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Token validation failed.');
      expect(result.error).toContain('spawn EINVAL');
    }
  });

  test('redacts credentialed stderr before it reaches the fallback error', async () => {
    const token = `ghp_${'b'.repeat(36)}`;
    const result = await runPatSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write("fatal: unable to access 'https://x-access-token:${token}@ghes.test/o/r.git/'");
        process.exitCode = 3;
      `),
      host: 'ghes.test',
      token,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(token);
      expect(result.error).toContain('https://[REDACTED]@ghes.test');
    }
  });

  test('redacts a bare PAT in stderr before it reaches the fallback error', async () => {
    const token = `ghp_${'g'.repeat(36)}`;
    const result = await runPatSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write("[auth] Failed to parse auth.yml: bad indentation at line 2:\\n  token: ${token}");
        process.exitCode = 3;
      `),
      host: 'ghes.test',
      token,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(token);
      expect(result.error).toContain('[REDACTED-GH-PAT]');
    }
  });

  test('forwards cliEnv through to the spawned CLI', async () => {
    const result = await runPatSubprocess({
      cliArgs: fixtureCli(`
        let d='';
        process.stdin.on('data', c => { d += c; });
        process.stdin.on('end', () => {
          process.stdout.write(JSON.stringify({ type: 'complete', host: 'ghes.test', login: process.env.OK_AUTH_PAT_ENV_MARKER || 'unset' }) + '\\n');
          process.exit(0);
        });
      `),
      cliEnv: { OK_AUTH_PAT_ENV_MARKER: 'marker-from-cli-env' },
      host: 'ghes.test',
      token: 'good-token',
    });
    expect(result).toEqual({ ok: true, host: 'ghes.test', login: 'marker-from-cli-env' });
  });
});
