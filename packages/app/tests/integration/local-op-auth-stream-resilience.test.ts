/**
 * HTTP auth-login stream resilience — a dropped connection must not lose a
 * sign-in that is still completing.
 *
 * Reported as inkeep/open-knowledge#803: on Windows, "Connect GitHub" shows a
 * device code and then fails with "Sign-in stream ended without confirmation".
 * The severed hop is the LOOPBACK one (browser ↔ local OK server), cut by an
 * intermediary the user never sees — an AV/EDR SSL-inspection agent, a VPN
 * local proxy, a backgrounded tab. Two properties turn that blip into a
 * permanent failure, and both are pinned here:
 *
 *   1. The stream sat at zero bytes for the whole authorization wait, which is
 *      what an idle-connection reaper looks for. The server now heartbeats.
 *   2. The disconnect SIGTERM'd the device-flow child, so authorizing on
 *      github.com afterwards stored nothing and there was nothing to recover.
 *      A disconnect is now a detach; only an EXPLICIT cancel kills the flow.
 *
 * These exercise the real `createApiExtension` route handlers over a real
 * `http.Server` via `createTestServer`, with fake device-flow CLIs injected
 * through `localOpCliArgs` — no real GitHub, no real `auth login` child. Each
 * fake records its own fate (SIGTERM vs ran-to-completion) in a marker file, so
 * the assertions are about observable subprocess lifetime rather than handler
 * internals.
 */

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

/**
 * Fake device-flow CLI that models the #803 timeline: emit a code, then have
 * the user authorize `authorizeAfterMs` later. It records which way it ended —
 * `sigterm` if it was killed, `completed` if it lived long enough to store a
 * token — so a test can assert the flow's fate with the client long gone.
 */
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

/**
 * POST a login and read until the first `verification` event. Leaves the
 * response stream open so the caller can sever it via the returned controller.
 * Returns the reader too, for tests that keep consuming (heartbeats).
 */
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

/**
 * Capture the structured `console.warn` events the handler emits. The server
 * runs in this process, so its `console.warn` is ours.
 */
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
    // The core regression. The user has the code on screen, the loopback stream
    // is severed, and the user then authorizes on github.com. If the disconnect
    // kills the child, that authorization stores nothing and the sign-in is
    // unrecoverable no matter what the UI does next.
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
      // The stream is severed while the user is still on github.com.
      login.controller.abort();

      // A flow left running with nobody attached is logged, so the "it detached
      // rather than died" path is visible in a support bundle instead of only
      // being inferable later from a displacement warn.
      await pollUntil(() => warns.events.some((e) => e.includes('auth-stream-detached')), 5000, 20);
      expect(warns.events.some((e) => e.includes('auth-stream-detached'))).toBe(true);

      // The flow must run to completion anyway.
      await pollUntil(() => existsSync(completedMarker), 5000, 20);
    } finally {
      warns.restore();
    }
    expect(existsSync(completedMarker)).toBe(true);
    expect(existsSync(sigtermMarker)).toBe(false);
  });

  test('an explicit cancel does kill the flow — backing out still means backing out', async () => {
    // The property the old kill-on-disconnect protected. It did not disappear;
    // it moved onto a signal that actually means intent.
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
      // Mirror the real client: `AuthTransportHandle.cancel()` POSTs the cancel
      // and THEN aborts the stream, so the socket closes while the child is
      // still winding down from the SIGTERM. That ordering is what makes the
      // slot-ownership check in `onClientClose` load-bearing.
      login.controller.abort();
      await pollUntil(() => existsSync(sigtermMarker), 5000, 20);
      // Give a would-be spurious detach log time to fire.
      await wait(150);
    } finally {
      warns.restore();
    }
    expect(existsSync(sigtermMarker)).toBe(true);
    // The child died well before its "user authorized" timer, so no token was
    // ever stored.
    expect(existsSync(completedMarker)).toBe(false);
    // A deliberate cancel is NOT a detach. The socket closes here too, so
    // without the slot-ownership check in `onClientClose` this would log one —
    // and a detach event that fires on every normal cancel tells an operator
    // nothing about whether an intermediary is cutting streams.
    expect(warns.events.some((e) => e.includes('auth-stream-detached'))).toBe(false);
  });

  test('cancel frees the slot synchronously — the next login acquires it without displacement', async () => {
    // A cancel that killed the child but left the slot held would 429 the very
    // next attempt during the SIGTERM-to-exit window. Isolation: displacement
    // would ALSO admit the next login, so "200" alone can't tell a working
    // release from one masked by the backstop — assert the displacement warn
    // never fired. The server runs in-process, so its `console.warn` is ours.
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
    // The client fires this on modal close without knowing the server's state.
    server = await createTestServer({});
    expect(await postAuthCancel('login')).toBe(200);
    expect(await postAuthCancel()).toBe(200);
  });

  test('cancelling the gh-login channel leaves an in-flight device-flow login alone', async () => {
    // Each streaming flow owns its own concurrency slot; a cancel names one.
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
    // Between `verification` and `complete` the flow writes nothing for as long
    // as the user takes to authorize. A connection carrying zero bytes is what
    // an idle reaper severs, so the envelope keeps bytes moving. Cadence is
    // shortened here; production is 15s.
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
      // A terminated stream is the failure this guards: pings must never end it.
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
    // The keepalive carries no meaning of its own — no terminal event snuck in.
    expect(types).not.toContain('complete');
    expect(types).not.toContain('error');

    login.controller.abort();
  });

  test('the keepalive stops when the client goes away', async () => {
    // A detached flow must not keep writing to a dead socket for the rest of
    // the code's 15-minute life.
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

    // Many heartbeat periods pass with no attached client. If the interval kept
    // firing at a destroyed response the writes would throw past the guard.
    await wait(400);
    expect(existsSync(sigtermMarker)).toBe(false);
  });
});
