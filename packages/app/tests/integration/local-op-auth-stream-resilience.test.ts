import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createTestServer, pollUntil, type TestServer, wait } from './test-harness';

let server: TestServer;
const openControllers: AbortController[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const c of openControllers) c.abort();
  openControllers.length = 0;
  if (server) await server.cleanup();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function scratchDir(): { sigtermMarker: string; completedMarker: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ok-auth-resilience-'));
  tmpDirs.push(dir);
  return { sigtermMarker: join(dir, 'sigterm'), completedMarker: join(dir, 'completed') };
}

function timedDeviceFlowCli(opts: {
  sigtermMarker: string;
  completedMarker: string;
  authorizeAfterMs: number;
}): string[] {
  return [
    process.execPath,
    '-e',
    `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        try { fs.writeFileSync(${JSON.stringify(opts.sigtermMarker)}, '1'); } catch (e) {}
        process.exit(0);
      });
      console.log(JSON.stringify({type:'verification', user_code:'WDJB-MJHT', verification_uri:'https://github.com/login/device', expires_in:900}));
      setTimeout(() => {
        try { fs.writeFileSync(${JSON.stringify(opts.completedMarker)}, '1'); } catch (e) {}
        console.log(JSON.stringify({type:'complete', host:'github.com', login:'octocat'}));
        process.exit(0);
      }, ${opts.authorizeAfterMs});
    `,
  ];
}

async function openLoginUntilVerification(): Promise<{
  status: number;
  sawVerification: boolean;
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
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
    return { status: res.status, sawVerification: false, controller, reader: null };
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
      if ((JSON.parse(line) as { type?: string }).type === 'verification') {
        return { status: res.status, sawVerification: true, controller, reader };
      }
    }
  }
  return { status: res.status, sawVerification: false, controller, reader };
}

function captureServerWarns(): { events: string[]; restore: () => void } {
  const events: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]): void => {
    if (typeof args[0] === 'string') events.push(args[0]);
  };
  return {
    events,
    restore: () => {
      console.warn = orig;
    },
  };
}

async function postAuthCancel(channel?: 'login' | 'gh-login'): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/local-op/auth/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(channel ? { channel } : {}),
  });
  await res.text().catch(() => {});
  return res.status;
}

describe('auth-login survives a transport drop (#803)', () => {
  test('a disconnected client does not kill the device flow — the token still lands', async () => {
    const { sigtermMarker, completedMarker } = scratchDir();
    server = await createTestServer({
      localOpCliArgs: timedDeviceFlowCli({
        sigtermMarker,
        completedMarker,
        authorizeAfterMs: 600,
      }),
    });

    const login = await openLoginUntilVerification();
    expect(login.status).toBe(200);
    expect(login.sawVerification).toBe(true);

    const warns = captureServerWarns();
    try {
      login.controller.abort();

      await pollUntil(() => warns.events.some((e) => e.includes('auth-stream-detached')), 5000, 20);
      expect(warns.events.some((e) => e.includes('auth-stream-detached'))).toBe(true);

      await pollUntil(() => existsSync(completedMarker), 5000, 20);
    } finally {
      warns.restore();
    }
    expect(existsSync(completedMarker)).toBe(true);
    expect(existsSync(sigtermMarker)).toBe(false);
  });

  test('an explicit cancel does kill the flow — backing out still means backing out', async () => {
    const { sigtermMarker, completedMarker } = scratchDir();
    server = await createTestServer({
      localOpCliArgs: timedDeviceFlowCli({
        sigtermMarker,
        completedMarker,
        authorizeAfterMs: 3000,
      }),
    });

    const login = await openLoginUntilVerification();
    expect(login.sawVerification).toBe(true);

    const warns = captureServerWarns();
    try {
      expect(await postAuthCancel('login')).toBe(200);
      login.controller.abort();
      await pollUntil(() => existsSync(sigtermMarker), 5000, 20);
      await wait(150);
    } finally {
      warns.restore();
    }
    expect(existsSync(sigtermMarker)).toBe(true);
    expect(existsSync(completedMarker)).toBe(false);
    expect(warns.events.some((e) => e.includes('auth-stream-detached'))).toBe(false);
  });

  test('cancel frees the slot synchronously — the next login acquires it without displacement', async () => {
    const { sigtermMarker, completedMarker } = scratchDir();
    server = await createTestServer({
      localOpCliArgs: timedDeviceFlowCli({
        sigtermMarker,
        completedMarker,
        authorizeAfterMs: 5000,
      }),
    });

    const first = await openLoginUntilVerification();
    expect(first.sawVerification).toBe(true);
    expect(await postAuthCancel('login')).toBe(200);

    const displacementWarns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      const head = typeof args[0] === 'string' ? args[0] : '';
      if (head.includes('idempotent-start-replaced-stale-slot')) displacementWarns.push(head);
    };
    try {
      const second = await openLoginUntilVerification();
      expect(second.status).toBe(200);
      expect(second.sawVerification).toBe(true);
      second.controller.abort();
    } finally {
      console.warn = origWarn;
    }
    expect(displacementWarns).toHaveLength(0);
  });

  test('cancel is idempotent — cancelling with nothing in flight is a 200, not an error', async () => {
    server = await createTestServer({});
    expect(await postAuthCancel('login')).toBe(200);
    expect(await postAuthCancel()).toBe(200);
  });

  test('cancelling the gh-login channel leaves an in-flight device-flow login alone', async () => {
    const { sigtermMarker, completedMarker } = scratchDir();
    server = await createTestServer({
      localOpCliArgs: timedDeviceFlowCli({
        sigtermMarker,
        completedMarker,
        authorizeAfterMs: 800,
      }),
    });

    const login = await openLoginUntilVerification();
    expect(login.sawVerification).toBe(true);

    expect(await postAuthCancel('gh-login')).toBe(200);

    await pollUntil(() => existsSync(completedMarker), 5000, 20);
    expect(existsSync(completedMarker)).toBe(true);
    expect(existsSync(sigtermMarker)).toBe(false);
  });
});

describe('auth-login stream keepalive', () => {
  test('an idle stream emits periodic ping lines and stays open', async () => {
    const { sigtermMarker, completedMarker } = scratchDir();
    server = await createTestServer({
      authStreamHeartbeatMs: 100,
      localOpCliArgs: timedDeviceFlowCli({
        sigtermMarker,
        completedMarker,
        authorizeAfterMs: 60_000,
      }),
    });

    const login = await openLoginUntilVerification();
    expect(login.sawVerification).toBe(true);
    const reader = login.reader;
    expect(reader).not.toBeNull();
    if (!reader) return;

    const decoder = new TextDecoder();
    const types: string[] = [];
    let buffer = '';
    const deadline = Date.now() + 3000;
    while (types.filter((t) => t === 'ping').length < 3 && Date.now() < deadline) {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        types.push((JSON.parse(line) as { type?: string }).type ?? '');
      }
    }

    expect(types.filter((t) => t === 'ping').length).toBeGreaterThanOrEqual(3);
    expect(types).not.toContain('complete');
    expect(types).not.toContain('error');

    login.controller.abort();
  });

  test('the keepalive stops when the client goes away', async () => {
    const { sigtermMarker, completedMarker } = scratchDir();
    server = await createTestServer({
      authStreamHeartbeatMs: 50,
      localOpCliArgs: timedDeviceFlowCli({
        sigtermMarker,
        completedMarker,
        authorizeAfterMs: 60_000,
      }),
    });

    const login = await openLoginUntilVerification();
    expect(login.sawVerification).toBe(true);
    login.controller.abort();

    await wait(400);
    expect(existsSync(sigtermMarker)).toBe(false);
  });
});
