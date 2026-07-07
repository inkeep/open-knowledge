/**
 * Subprocess runner — foundational behavior used by both auth + clone flows.
 *
 * Fixture subprocesses are spawned via `process.execPath -e <script>` so the
 * tests stay self-contained (no dependence on the project CLI being on PATH).
 */

import { describe, expect, test } from 'bun:test';
import { delimiter as PATH_DELIMITER } from 'node:path';
import { runSubprocess } from './subprocess.ts';

const fixtureCli = (script: string): readonly string[] => [process.execPath, '-e', script];

describe('runSubprocess', () => {
  test('emits one parsed line per NDJSON event from stdout', async () => {
    const lines: { raw: string; parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'a', n:1}));
        console.log(JSON.stringify({type:'b', n:2}));
      `),
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    const result = await proc.done;
    expect(result.code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0].parsed).toEqual({ type: 'a', n: 1 });
    expect(lines[1].parsed).toEqual({ type: 'b', n: 2 });
  });

  test('flushes a trailing partial line that lacks a newline terminator', async () => {
    const lines: { raw: string; parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli(`process.stdout.write('{"a":1}')`),
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    expect(lines).toHaveLength(1);
    expect(lines[0].parsed).toEqual({ a: 1 });
  });

  test('non-JSON line forwards with parsed:null (caller decides what to do)', async () => {
    const lines: { raw: string; parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli(`console.log('hello world')`),
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    expect(lines).toHaveLength(1);
    expect(lines[0].raw).toBe('hello world');
    expect(lines[0].parsed).toBeNull();
  });

  test('captures stderr verbatim and surfaces nonzero exit code', async () => {
    const stderrChunks: Buffer[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli(`process.stderr.write('boom\\n'); process.exit(7)`),
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: () => {},
      onStderr: (chunk) => stderrChunks.push(chunk),
    });
    const result = await proc.done;
    expect(result.code).toBe(7);
    expect(result.stderr).toContain('boom');
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(Buffer.concat(stderrChunks).toString('utf-8')).toContain('boom');
  });

  test('cancel SIGTERMs the child and reports cancelled:true', async () => {
    const proc = runSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
      trailingArgs: [],
      timeoutMs: 60_000,
      onLine: () => {},
    });
    setTimeout(() => proc.cancel(), 50);
    const result = await proc.done;
    expect(result.cancelled).toBe(true);
    // Process exited via signal; exit code reported as null.
    expect(result.code).toBeNull();
  });

  test('cancel is idempotent — calling more than once is safe', async () => {
    const proc = runSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
      trailingArgs: [],
      timeoutMs: 60_000,
      onLine: () => {},
    });
    proc.cancel();
    proc.cancel();
    proc.cancel();
    const result = await proc.done;
    expect(result.cancelled).toBe(true);
  });

  test('timeout SIGTERMs the child and reports timedOut:true', async () => {
    const proc = runSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
      trailingArgs: [],
      timeoutMs: 100,
      onLine: () => {},
    });
    const result = await proc.done;
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.code).toBeNull();
  });

  test('empty cliArgs returns a clean error result without spawning', async () => {
    const proc = runSubprocess({
      cliArgs: [],
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: () => {},
    });
    const result = await proc.done;
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain('no command');
    proc.cancel();
  });

  test('handles a chunked stream that splits a JSON line across writes', async () => {
    const lines: { raw: string; parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli(`
        process.stdout.write('{"part":');
        setTimeout(() => process.stdout.write('1}\\n'), 30);
      `),
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    expect(lines).toHaveLength(1);
    expect(lines[0].parsed).toEqual({ part: 1 });
  });

  test('blank stdout lines are skipped (not forwarded)', async () => {
    const lines: { raw: string }[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli(`console.log(''); console.log('   '); console.log('keep');`),
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    expect(lines.map((l) => l.raw)).toEqual(['keep']);
  });

  // `extraPathDirs` is the clone-flow git-binding mechanism: the caller's
  // git-preflight resolves a usable git and prepends its dir so the spawned
  // `<cli> clone`'s internal `git` resolves to the validated binary.
  const echoPathCli = fixtureCli(`console.log(JSON.stringify({ path: process.env.PATH }))`);
  const childPathFrom = (lines: { parsed: Record<string, unknown> | null }[]): string =>
    String(lines[0]?.parsed?.path ?? '');

  test('extraPathDirs prepends to the child PATH in order, ahead of the inherited PATH', async () => {
    const lines: { parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: echoPathCli,
      trailingArgs: [],
      extraPathDirs: ['/opt/one', '/opt/two'],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    const childPath = childPathFrom(lines);
    expect(childPath.startsWith(`/opt/one${PATH_DELIMITER}/opt/two${PATH_DELIMITER}`)).toBe(true);
    expect(childPath.endsWith(process.env.PATH ?? '')).toBe(true);
  });

  test('absent extraPathDirs leaves the child PATH untouched', async () => {
    const lines: { parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: echoPathCli,
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    expect(childPathFrom(lines)).toBe(process.env.PATH ?? '');
  });

  test('extraPathDirs drops empty segments when composing the child PATH', async () => {
    const lines: { parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: echoPathCli,
      trailingArgs: [],
      extraPathDirs: ['', '/opt/only'],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    const childPath = childPathFrom(lines);
    // The leading empty string is filtered — the child PATH must not start with
    // an empty segment (a `${DELIM}`-prefixed PATH resolves the cwd implicitly).
    expect(childPath.split(PATH_DELIMITER)[0]).toBe('/opt/only');
  });
});
