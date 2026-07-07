/**
 * Device-flow runner — covers the JSON-shape parser, terminal-event tracking,
 * synthesized-complete-on-clean-exit fallback, and timeout/error reporting.
 *
 * Fixture subprocesses spawned via `process.execPath -e <script>` so the tests
 * don't require the project CLI on PATH.
 */
import { describe, expect, test } from 'bun:test';
import { runDeviceFlowSubprocess } from './auth-flow.ts';
import type { AuthEvent } from './types.ts';

const fixtureCli = (script: string): readonly string[] => [process.execPath, '-e', script];

describe('runDeviceFlowSubprocess', () => {
  test('forwards verification + complete events parsed from stdout', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'verification', user_code:'ABCD', verification_uri:'https://example.com/login', expires_in:60}));
        console.log(JSON.stringify({type:'complete', host:'github.com', login:'me', name:'Me', email:'me@example.com', avatarUrl:'https://example.com/me.png'}));
      `),
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'verification',
      user_code: 'ABCD',
      verification_uri: 'https://example.com/login',
      expires_in: 60,
    });
    expect(events[1]).toEqual({
      type: 'complete',
      host: 'github.com',
      login: 'me',
      name: 'Me',
      email: 'me@example.com',
      avatarUrl: 'https://example.com/me.png',
    });
  });

  test('synthesizes a complete event on clean exit without one (older CLI builds)', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`process.exit(0)`),
      host: 'github.com',
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'complete', host: 'github.com', login: '' });
  });

  test('synthesized complete uses default host when not specified', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`process.exit(0)`),
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events[0]).toEqual({ type: 'complete', host: 'github.com', login: '' });
  });

  test('emits structured error event on nonzero exit', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`process.exit(2)`),
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type === 'error') {
      expect(events[0].message).toContain('exited with code 2');
    }
  });

  test('emits "Sign-in timed out" error on timeout', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
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

  test('CLI-emitted error event is forwarded as-is and counts as terminal', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      // Exit code 0 — but the CLI emitted 'error', so the runner MUST NOT
      // synthesize a second complete event on top.
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'error', message:'bad code'}));
        process.exit(0);
      `),
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'error', message: 'bad code' });
  });

  test('malformed JSON lines are silently dropped, not forwarded as errors', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`
        console.log('this is not json');
        console.log(JSON.stringify({type:'verification', user_code:'X', verification_uri:'https://e.com', expires_in:60}));
        console.log(JSON.stringify({type:'complete', host:'github.com', login:'me'}));
      `),
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events.map((e) => e.type)).toEqual(['verification', 'complete']);
  });

  test('verification events with missing required fields are dropped', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'verification', user_code:'X'}));
        console.log(JSON.stringify({type:'complete', host:'github.com', login:'me'}));
      `),
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    // First line dropped (missing verification_uri + expires_in); second forwarded.
    expect(events.map((e) => e.type)).toEqual(['complete']);
  });

  test('unknown JSON event types are dropped', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'keychain-probe', backend:'darwin'}));
        console.log(JSON.stringify({type:'complete', host:'github.com', login:'me'}));
      `),
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events.map((e) => e.type)).toEqual(['complete']);
  });

  test('cancel terminates the subprocess', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
      onEvent: (e) => events.push(e),
    });
    setTimeout(() => ctrl.cancel(), 50);
    await ctrl.done;
    // Cancel via SIGTERM yields code:null, which the runner currently
    // surfaces as an error event ("auth login exited with code -1"). Asserts
    // current behavior; reconsider if cancel should silence the error.
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('error');
  });
});
