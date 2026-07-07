/**
 * HTTP auth-login concurrency-slot lifecycle — the cancel→reopen contract.
 *
 * Invariant under test: a cancelled / disconnected auth-login must immediately
 * free or displace the concurrency slot, so a fresh login attempt is always
 * admittable. Closing the device-flow modal without completing must NOT block
 * the next start.
 *
 * The desktop editor window drives `POST /api/local-op/auth/login` over HTTP
 * (the Navigator window uses the IPC twin, hardened separately). These tests
 * exercise the real `createApiExtension` route handler over a real
 * `http.Server` via `createTestServer`, with a fake device-flow CLI injected
 * through `localOpCliArgs` — no real GitHub, no real `auth login` child.
 *
 * The fake CLI emits a `verification` event (so the slot is genuinely held in
 * mid-device-flow) and then swallows SIGTERM, self-exiting only after a bounded
 * delay. That models the real-world "child slow to exit on cancel" condition
 * (slow GitHub fetch teardown, or a packaged wrapper that spawns-not-execs):
 * the slot stays pinned for the child's lifetime unless the handler frees or
 * displaces it. With a prompt-dying child the leak would be a brief race
 * window; the slow-die child makes the defect deterministic.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestServer, pollUntil, type TestServer, wait } from './test-harness';

// Fake device-flow CLI: ignores the appended `auth login --json --host ...`
// argv, prints one verification line, then swallows SIGTERM and lingers. The
// bounded self-exit keeps the test from leaking a process; it is far longer
// than the per-request measurement window (verification + a follow-up POST land
// within milliseconds), so on unfixed code the slot is still pinned when the
// reopen arrives.
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
// Per-test scratch dirs holding the signal-gated fake CLI's exit-marker + go
// files (ownership-guard test only). Removed after the server tears down so
// any child still polling for the go-signal has already been SIGTERM'd by the
// controller aborts below; the fake CLI also has a hard self-exit fallback so
// removing the go-signal can never leak a process.
const tmpDirs: string[] = [];

afterEach(async () => {
  // Abort any still-streaming login so the server tears down its child, then
  // shut the server down.
  // `AbortController.abort()` is idempotent per the WHATWG spec — safe to call
  // on an already-aborted controller, no try/catch needed.
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

/**
 * POST a login request and read the NDJSON stream until the first
 * `verification` event arrives (or the stream / status says otherwise).
 * Leaves the response stream open so the caller can simulate a client
 * disconnect by aborting the returned controller.
 */
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
    // Drain a non-streaming (e.g. 429 problem+json) body so the connection
    // closes cleanly; report the status to the caller.
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

    // First login: acquires the slot and enters the device flow.
    const first = await openLoginUntilVerification();
    expect(first.status).toBe(200);
    expect(first.verification?.type).toBe('verification');

    // Client closes the modal. The child swallows SIGTERM and is still alive.
    disconnect(first.controller);

    // Reopen: a fresh login must NOT be rejected with 429. The slot has to be
    // freed (synchronous release on disconnect) or displaced (fresh-start
    // backstop). On the unfixed handler the slot is still held by the lingering
    // child, so this reopen gets 429 "An auth login operation is already in
    // progress." and the assertions below fail.
    const second = await openLoginUntilVerification();
    expect(second.status).not.toBe(429);
    expect(second.status).toBe(200);
    // The reopened login genuinely re-enters the device flow (proves a real
    // admitted flow, not merely a non-429 status).
    expect(second.verification?.type).toBe('verification');

    disconnect(second.controller);
  });

  test('repeated open→cancel cycles never permanently pin the slot', async () => {
    server = await createTestServer({ localOpCliArgs: SLOW_DIE_CLI });

    // Models the user report: open → cancel → reopen, repeated. Every reopen
    // must be admittable. On the unfixed handler the second cycle already
    // 429s because the first cancelled child still pins the slot.
    for (let cycle = 1; cycle <= 3; cycle++) {
      const attempt = await openLoginUntilVerification();
      expect(attempt.status).toBe(200);
      expect(attempt.verification?.type).toBe('verification');
      disconnect(attempt.controller);
    }
  });

  test("a cancelled login's late child-exit does not release the successor's slot (ownership-guarded release)", async () => {
    // Pins the subtle correctness property a synchronous-free + displacement
    // fix still needs: object-identity ownership on the slot release. After a
    // login is cancelled and a FRESH login is admitted, the OLD (cancelled)
    // device-flow child eventually exits — and its `done.finally` must NOT
    // release the slot the successor now owns. Without the ownership guard
    // (`authLoginInFlight === flow`), the stale child's late `done.finally`
    // deletes the Set key the successor holds, so a third start no longer
    // displaces the live login but spuriously acquires a "free" slot — leaking
    // the second login's child as an orphaned background poller (the exact
    // "don't leave a poller writing an unconfirmed token" property the
    // disconnect handler exists for).
    //
    // The fake CLI here exits SOON after SIGTERM (not after a long linger) so
    // the cancelled child's `done.finally` fires DURING the measurement window,
    // while the successor owns the slot. To remove timing flakiness the exit is
    // gated on a `go` file the test writes only after the successor is admitted:
    // child exit (and therefore the late release) is ordered strictly after the
    // successor claims the slot, with no wall-clock race.
    //
    // Observable contract (no assertions on the private `authLoginInFlight`):
    // each device-flow child appends its pid to an exit-marker file when it is
    // terminated. With the ownership guard, the third start finds the slot still
    // held by login #2 and DISPLACES it — SIGTERM-ing #2's child, so two prior
    // children (the cancelled #1 and the displaced #2) record an exit. Without
    // the guard, #1's late release frees #2's slot, the third start acquires
    // without displacing, #2's child is never terminated, and only one prior
    // child records an exit.
    //
    // RED status: on the CURRENT (unfixed) handler this test fails earlier, at
    // the "#2 admitted" step, for the same reason the two tests above fail (the
    // slot stays pinned → reopen 429s). The ownership property it isolates is
    // only reachable once the synchronous-free + displacement halves land; it
    // then PASSES, and regresses to RED if the ownership guard on the release is
    // later removed.
    const dir = mkdtempSync(join(tmpdir(), 'ok-auth-ownership-'));
    tmpDirs.push(dir);
    const exitMarker = join(dir, 'child-exits.log');
    const goSignal = join(dir, 'go');

    // Fake device-flow CLI: emit one verification line, then stay alive until
    // SIGTERM. On SIGTERM, wait for the test's `go` file (or a hard 5s fallback
    // so a never-released child can't leak), append this child's pid to the
    // exit-marker, and exit — which is what resolves the server-side
    // `flow.done` and fires the handler's `done.finally`.
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

    // Login #1 acquires the slot and enters the device flow.
    const first = await openLoginUntilVerification();
    expect(first.status).toBe(200);
    expect(first.verification?.type).toBe('verification');

    // Client closes the modal → res.on('close') → flow.cancel() → SIGTERM to
    // child #1. The child does not exit yet (no go-signal).
    disconnect(first.controller);

    // Login #2 (reopen) must be admitted and now OWNS the slot. (Unfixed code
    // 429s here — the masked failure shared with the tests above.)
    const second = await openLoginUntilVerification();
    expect(second.status).toBe(200);
    expect(second.verification?.type).toBe('verification');

    // Now let the cancelled child #1 exit — strictly after #2 claimed the slot.
    // Its `done.finally` fires here; the ownership guard must stop it from
    // releasing #2's slot.
    writeFileSync(goSignal, '1', 'utf-8');
    await pollUntil(() => markerCount() >= 1, 5000, 20);
    // Drain the in-process event loop so the cancelled child's `close` →
    // `flow.done` → `done.finally` runs BEFORE the third start observes the
    // slot (server runs in this same process — same pattern awaitDocQuiescence
    // uses to settle in-process callbacks).
    for (let i = 0; i < 10; i++) await wait(0);

    // Third start. With the ownership guard the slot is still held by #2, so
    // this DISPLACES #2 (SIGTERM-ing its child); without the guard the slot was
    // wrongly freed, so this acquires without displacing and #2's child is left
    // running.
    const third = await openLoginUntilVerification();
    expect(third.status).toBe(200);
    expect(third.verification?.type).toBe('verification');

    // Contract: two prior children (#1 cancelled, #2 displaced) must have been
    // terminated. If #1's late release freed #2's slot, #2 is orphaned and only
    // one child ever records an exit → this times out (RED).
    await pollUntil(() => markerCount() >= 2, 4000, 20);
    expect(markerCount()).toBeGreaterThanOrEqual(2);

    disconnect(third.controller);
  });

  test('a login that completes normally releases the slot, and the next login is admitted via normal acquisition (not displacement)', async () => {
    // Pins the happy-path release. The three tests above all exercise the
    // cancel / displace paths; none covers a login that COMPLETES. When a
    // device flow completes, `flow.done` resolves and the ownership-guarded
    // `done.finally` must release the slot so the next login acquires it via
    // the normal `tryAcquire` path.
    //
    // Isolation: a broken normal-release would NOT show up as a 429 on the
    // next login — the displacement backstop would still admit it (re-owning
    // the slot held by the dead, completed flow). So "next login is 200" alone
    // can't distinguish a working release from a release that regressed and was
    // masked by displacement. We therefore also assert the displacement warn
    // never fired: admission via the normal path emits no
    // `idempotent-start-replaced-stale-slot`. The server runs in-process, so
    // its `console.warn` is this process's `console.warn`.
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
      // Login #1: consume the FULL NDJSON stream (verification + complete),
      // so the child has exited and `flow.done` is resolving by the time the
      // stream closes — not just the verification prefix.
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
      // Settle the in-process `close` → `flow.done` → `done.finally` so the
      // slot is released before login #2 observes it (same in-process settle
      // pattern the ownership test uses).
      for (let i = 0; i < 10; i++) await wait(0);

      // Login #2 must be admitted by NORMAL acquisition (the completed #1
      // released the slot), not by displacing a stale controller.
      const second = await openLoginUntilVerification();
      expect(second.status).toBe(200);
      expect(second.verification?.type).toBe('verification');
    } finally {
      console.warn = origWarn;
    }

    // The successor acquired the freed slot directly: had `done.finally`'s
    // release regressed, the slot would still be held by the dead completed
    // flow and #2 would have been admitted via displacement — which logs this.
    expect(displacementWarns).toHaveLength(0);
  });
});
