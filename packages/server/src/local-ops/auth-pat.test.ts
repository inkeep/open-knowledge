/**
 * PAT runner — covers the stdin token hand-off, the complete/error JSON
 * parsing, and the generic fallback on an unexpected exit.
 *
 * Fixture subprocesses are spawned via `process.execPath -e <script>` so the
 * tests exercise the real spawn + stdin-write + NDJSON-parse path.
 */
import { describe, expect, test } from 'vitest';
import { runPatSubprocess } from './auth-pat.ts';

const fixtureCli = (script: string): readonly string[] => [process.execPath, '-e', script];

// Reads stdin to EOF; echoes it into the `login` on success so the test can
// prove the token reached the child over stdin (not argv/env).
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
});
