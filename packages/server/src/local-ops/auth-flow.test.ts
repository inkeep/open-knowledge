import { describe, expect, test } from 'vitest';
import { type RunDeviceFlowController, runDeviceFlowSubprocess } from './auth-flow.ts';
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

  test('CLI-emitted error event is forwarded and counts as terminal', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
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

  test('CLI-emitted error message is redacted and capped before it reaches the consumer', async () => {
    const events: AuthEvent[] = [];
    const token = `ghp_${'c'.repeat(36)}`;
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`
        const message = "[auth] Failed to parse auth.yml at line 2:\\n  token: ${token} " + "z".repeat(3000);
        console.log(JSON.stringify({type:'error', message}));
      `),
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type === 'error') {
      expect(events[0].message).not.toContain(token);
      expect(events[0].message).toContain('[REDACTED-GH-PAT]');
      expect(events[0].message.length).toBeLessThanOrEqual(500);
    }
  });

  test('CLI-emitted error message that redacts to nothing falls back to "Unknown error"', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'error', message:'   \\n  '}));
      `),
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events).toEqual([{ type: 'error', message: 'Unknown error' }]);
  });

  test('a cancel landing after the timeout still reports the timeout', async () => {
    const events: AuthEvent[] = [];
    const ctrl: RunDeviceFlowController = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`
        process.on('SIGTERM', () => {
          console.log(JSON.stringify({type:'verification', user_code:'TERM', verification_uri:'https://e.com/login', expires_in:60}));
          setTimeout(() => process.exit(7), 200);
        });
        setInterval(() => {}, 1000);
      `),
      timeoutMs: 800,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'verification') ctrl.cancel();
      },
    });
    await ctrl.done;
    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeDefined();
    if (errEvent?.type === 'error') {
      expect(errEvent.message).toMatch(/timed out/i);
    }
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

  test('non-zero exit folds the child stderr into the error message', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write('spawn EINVAL');
        process.exitCode = 2;
      `),
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type === 'error') {
      expect(events[0].message).toContain('exited with code 2');
      expect(events[0].message).toContain('spawn EINVAL');
    }
  });

  test('credentialed stderr is redacted before it reaches the error message', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write("fatal: unable to access 'https://x-access-token:${token}@github.com/o/r.git/'");
        process.exitCode = 2;
      `),
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') {
      expect(events[0].message).not.toContain(token);
      expect(events[0].message).toContain('https://[REDACTED]@github.com');
    }
  });

  test('a bare PAT in stderr is redacted before it reaches the error message', async () => {
    const token = `ghp_${'f'.repeat(36)}`;
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`
        process.stderr.write("[auth] Failed to parse auth.yml: bad indentation at line 2:\\n  token: ${token}");
        process.exitCode = 2;
      `),
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') {
      expect(events[0].message).not.toContain(token);
      expect(events[0].message).toContain('[REDACTED-GH-PAT]');
    }
  });

  test('forwards cliEnv through to the spawned CLI', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'complete', host:'github.com', login: process.env.OK_AUTH_FLOW_ENV_MARKER || 'unset'}));
      `),
      cliEnv: { OK_AUTH_FLOW_ENV_MARKER: 'marker-from-cli-env' },
      onEvent: (e) => events.push(e),
    });
    await ctrl.done;
    expect(events[0]?.type).toBe('complete');
    if (events[0]?.type === 'complete') {
      expect(events[0].login).toBe('marker-from-cli-env');
    }
  });

  test('cancel terminates the subprocess without synthesizing an error event', async () => {
    const events: AuthEvent[] = [];
    const ctrl = runDeviceFlowSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
      onEvent: (e) => events.push(e),
    });
    setTimeout(() => ctrl.cancel(), 50);
    await ctrl.done;
    expect(events).toEqual([]);
  });
});
