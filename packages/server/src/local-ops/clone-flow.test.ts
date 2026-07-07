/**
 * Clone-flow runner — covers the JSON-shape parser, terminal-event tracking,
 * timeout/error reporting, stderr inclusion in error messages, and the
 * `validateCloneInputs` URL/path allowlists.
 */

import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type RawCloneEvent, runCloneSubprocess, validateCloneInputs } from './clone-flow.ts';

// `validateCloneInputs` confines the target to the user's home directory.
// All clone fixtures use a path under home so the runner-level tests don't
// trip on the path allowlist.
const HOME_PATH = join(homedir(), 'open-knowledge-test-clone');

const fixtureCli = (script: string): readonly string[] => [process.execPath, '-e', script];

describe('runCloneSubprocess', () => {
  test('forwards progress + complete events parsed from stdout', async () => {
    const events: RawCloneEvent[] = [];
    const ctrl = runCloneSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'progress', phase:'receiving', pct:25}));
        console.log(JSON.stringify({type:'progress', phase:'resolving', pct:80}));
        console.log(JSON.stringify({type:'complete', dir:'/tmp/cloned-repo'}));
      `),
      url: 'https://github.com/octocat/hello.git',
      dir: '/tmp/cloned-repo',
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: 'progress', phase: 'receiving', pct: 25 });
    expect(events[1]).toEqual({ type: 'progress', phase: 'resolving', pct: 80 });
    expect(events[2]).toEqual({ type: 'complete', dir: '/tmp/cloned-repo' });
  });

  test('emits structured error event on nonzero exit, including stderr detail', async () => {
    const events: RawCloneEvent[] = [];
    const ctrl = runCloneSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write('fatal: repository not found\\n');
        process.exit(128);
      `),
      url: 'https://github.com/octocat/missing.git',
      dir: '/tmp/missing',
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type === 'error') {
      expect(events[0].message).toContain('exited with code 128');
      expect(events[0].message).toContain('fatal: repository not found');
    }
  });

  test('emits "Clone timed out" error on timeout', async () => {
    const events: RawCloneEvent[] = [];
    const ctrl = runCloneSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
      url: 'https://github.com/octocat/slow.git',
      dir: '/tmp/slow',
      timeoutMs: 100,
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeDefined();
    if (errEvent?.type === 'error') {
      expect(errEvent.message).toMatch(/timed out/i);
    }
  });

  test('CLI-emitted error event is forwarded as terminal — no second event synthesized', async () => {
    const events: RawCloneEvent[] = [];
    const ctrl = runCloneSubprocess({
      // CLI emits 'error' but exits with code 0 (e.g. graceful failure).
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'error', message:'permission denied'}));
        process.exit(0);
      `),
      url: 'https://github.com/octocat/locked.git',
      dir: '/tmp/locked',
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'error', message: 'permission denied' });
  });

  test('progress events with missing fields are dropped', async () => {
    const events: RawCloneEvent[] = [];
    const ctrl = runCloneSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'progress', phase:'receiving'}));
        console.log(JSON.stringify({type:'complete', dir:'/tmp/x'}));
      `),
      url: 'https://github.com/x/y.git',
      dir: '/tmp/x',
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    // First line dropped (missing pct); second forwarded.
    expect(events.map((e) => e.type)).toEqual(['complete']);
  });

  test('synthesizes a complete event when CLI exits 0 without emitting one', async () => {
    const events: RawCloneEvent[] = [];
    const ctrl = runCloneSubprocess({
      cliArgs: fixtureCli(`
        // Emit only an invalid (missing dir) line, then clean exit. The runner
        // ignores the malformed line and synthesizes a complete from opts.dir
        // so the IPC stream consumer's iterator can resolve.
        console.log(JSON.stringify({type:'complete'}));
        process.exit(0);
      `),
      url: 'https://github.com/x/y.git',
      dir: HOME_PATH,
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'complete', dir: HOME_PATH });
  });

  test('unknown JSON event types are dropped, terminal still detected', async () => {
    const events: RawCloneEvent[] = [];
    const ctrl = runCloneSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'unknown-event', stuff:'ignored'}));
        console.log(JSON.stringify({type:'complete', dir:'/tmp/y'}));
      `),
      url: 'https://github.com/x/y.git',
      dir: '/tmp/y',
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events.map((e) => e.type)).toEqual(['complete']);
  });

  test('cancel SIGTERMs the subprocess', async () => {
    const events: RawCloneEvent[] = [];
    const ctrl = runCloneSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
      url: 'https://github.com/x/y.git',
      dir: '/tmp/y',
      onEvent: (e) => events.push(e),
    });
    setTimeout(() => ctrl.cancel(), 50);
    await ctrl.done;
    // Cancel via SIGTERM yields code:null → runner reports as error event
    // ("Clone process exited with code -1"). Asserts current behavior.
    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeDefined();
  });

  test('handles a chunked stream that splits a JSON line across writes', async () => {
    const events: RawCloneEvent[] = [];
    const ctrl = runCloneSubprocess({
      cliArgs: fixtureCli(`
        process.stdout.write('{"type":"prog');
        setTimeout(() => process.stdout.write('ress","phase":"receiving","pct":50}\\n'), 30);
        setTimeout(() => console.log(JSON.stringify({type:'complete', dir:'/tmp/c'})), 60);
      `),
      url: 'https://github.com/x/y.git',
      dir: '/tmp/c',
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'progress', phase: 'receiving', pct: 50 });
    expect(events[1]).toEqual({ type: 'complete', dir: '/tmp/c' });
  });
});

describe('validateCloneInputs', () => {
  test('accepts allowed git URL + safe local path within home', () => {
    expect(validateCloneInputs('https://github.com/octocat/hello.git', HOME_PATH)).toEqual({
      ok: true,
    });
  });

  test('rejects path outside the user home directory', () => {
    const result = validateCloneInputs('https://github.com/x/y.git', '/etc/passwd-owner');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-dir');
  });

  test('accepts tilde-expansion paths', () => {
    expect(validateCloneInputs('https://github.com/x/y.git', '~/Documents/repo').ok).toBe(true);
  });

  test('rejects disallowed URL protocol', () => {
    const result = validateCloneInputs('javascript:alert(1)', '/tmp/x');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-url');
  });

  test('rejects path that is not safe for the local filesystem', () => {
    // Empty string is rejected by isSafeLocalPath.
    const result = validateCloneInputs('https://github.com/x/y.git', '');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-dir');
  });

  test('reports invalid-url first when both fail (URL is checked first)', () => {
    const result = validateCloneInputs('not-a-url', '');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-url');
  });
});
