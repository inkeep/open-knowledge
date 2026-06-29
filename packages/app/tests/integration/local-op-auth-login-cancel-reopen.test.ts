
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestServer, pollUntil, type TestServer, wait } from './test-harness';

const SLOW_DIE_CLI = [
  process.execPath,
  '-e',
  `
    process.on('SIGTERM', () => {});
    console.log(JSON.stringify({type:'verification', user_code:'WDJB-MJHT', verification_uri:'https://github.com/login/device', expires_in:900}));
    setTimeout(() => process.exit(0), 3000);
  `,
];

interface VerificationEvent {
  type: 'verification';
  user_code: string;
  verification_uri: string;
  expires_in: number;
}

let server: TestServer;
const openControllers: AbortController[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const c of openControllers) {
    c.abort();
  }
  openControllers.length = 0;
  if (server) await server.cleanup();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

async function openLoginUntilVerification(): Promise<{
  status: number;
  verification: VerificationEvent | null;
  controller: AbortController;
}> {
  const controller = new AbortController();
  openControllers.push(controller);

  const res = await fetch(`http://127.0.0.1:${server.port}/api/local-op/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: controller.signal,
  });

  if (res.status !== 200 || !res.body) {
    await res.text().catch(() => {});
    return { status: res.status, verification: null, controller };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line) as { type?: string };
      if (evt.type === 'verification') {
        reader.releaseLock();
        return { status: res.status, verification: evt as VerificationEvent, controller };
      }
    }
  }
  reader.releaseLock();
  return { status: res.status, verification: null, controller };
}

/** Simulate the client closing the modal: abort the in-flight login fetch.
 * The handler wires `res.on('close')` → `flow.cancel()`. */
function disconnect(controller: AbortController): void {
  controller.abort();
}

describe('HTTP auth-login cancel→reopen concurrency-slot contract', () => {
  test('a fresh login is admitted after the previous one is cancelled, while the cancelled child is still terminating', async () => {
    server = await createTestServer({ localOpCliArgs: SLOW_DIE_CLI });

    const first = await openLoginUntilVerification();
    expect(first.status).toBe(200);
    expect(first.verification?.type).toBe('verification');

    disconnect(first.controller);

    const second = await openLoginUntilVerification();
    expect(second.status).not.toBe(429);
    expect(second.status).toBe(200);
    expect(second.verification?.type).toBe('verification');

    disconnect(second.controller);
  });

  test('repeated open→cancel cycles never permanently pin the slot', async () => {
    server = await createTestServer({ localOpCliArgs: SLOW_DIE_CLI });

    for (let cycle = 1; cycle <= 3; cycle++) {
      const attempt = await openLoginUntilVerification();
      expect(attempt.status).toBe(200);
      expect(attempt.verification?.type).toBe('verification');
      disconnect(attempt.controller);
    }
  });

  test("a cancelled login's late child-exit does not release the successor's slot (ownership-guarded release)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-auth-ownership-'));
    tmpDirs.push(dir);
    const exitMarker = join(dir, 'child-exits.log');
    const goSignal = join(dir, 'go');

    const SIGNAL_GATED_CLI = [
      process.execPath,
      '-e',
      `
        const fs = require('node:fs');
        const EXIT_MARKER = ${JSON.stringify(exitMarker)};
        const GO_SIGNAL = ${JSON.stringify(goSignal)};
        let terminating = false;
        function flushAndExit() {
          try { fs.appendFileSync(EXIT_MARKER, process.pid + '\\n'); } catch (e) {}
          process.exit(0);
        }
        process.on('SIGTERM', () => {
          if (terminating) return;
          terminating = true;
          const started = Date.now();
          const poll = setInterval(() => {
            if (fs.existsSync(GO_SIGNAL) || Date.now() - started > 5000) {
              clearInterval(poll);
              flushAndExit();
            }
          }, 20);
        });
        console.log(JSON.stringify({type:'verification', user_code:'WDJB-MJHT', verification_uri:'https://github.com/login/device', expires_in:900}));
        setInterval(() => {}, 1 << 30);
      `,
    ];

    const markerCount = (): number => {
      try {
        return readFileSync(exitMarker, 'utf-8').split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    };

    server = await createTestServer({ localOpCliArgs: SIGNAL_GATED_CLI });

    const first = await openLoginUntilVerification();
    expect(first.status).toBe(200);
    expect(first.verification?.type).toBe('verification');

    disconnect(first.controller);

    const second = await openLoginUntilVerification();
    expect(second.status).toBe(200);
    expect(second.verification?.type).toBe('verification');

    writeFileSync(goSignal, '1', 'utf-8');
    await pollUntil(() => markerCount() >= 1, 5000, 20);
    for (let i = 0; i < 10; i++) await wait(0);

    const third = await openLoginUntilVerification();
    expect(third.status).toBe(200);
    expect(third.verification?.type).toBe('verification');

    await pollUntil(() => markerCount() >= 2, 4000, 20);
    expect(markerCount()).toBeGreaterThanOrEqual(2);

    disconnect(third.controller);
  });

  test('a login that completes normally releases the slot, and the next login is admitted via normal acquisition (not displacement)', async () => {
    const FAST_COMPLETE_CLI = [
      process.execPath,
      '-e',
      `
        console.log(JSON.stringify({type:'verification', user_code:'WDJB-MJHT', verification_uri:'https://github.com/login/device', expires_in:900}));
        console.log(JSON.stringify({type:'complete', host:'github.com', login:'octocat'}));
        process.exit(0);
      `,
    ];
    server = await createTestServer({ localOpCliArgs: FAST_COMPLETE_CLI });

    const displacementWarns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      const first = typeof args[0] === 'string' ? args[0] : '';
      if (first.includes('idempotent-start-replaced-stale-slot')) displacementWarns.push(first);
    };

    try {
      const controller = new AbortController();
      openControllers.push(controller);
      const res1 = await fetch(`http://127.0.0.1:${server.port}/api/local-op/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      expect(res1.status).toBe(200);
      const reader = res1.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
        reader.releaseLock();
      }
      for (let i = 0; i < 10; i++) await wait(0);

      const second = await openLoginUntilVerification();
      expect(second.status).toBe(200);
      expect(second.verification?.type).toBe('verification');
    } finally {
      console.warn = origWarn;
    }

    expect(displacementWarns).toHaveLength(0);
  });
});
