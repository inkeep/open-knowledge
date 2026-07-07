/**
 * Integration test for deterministic presence cleanup via the MCP
 * keepalive WS close event (plus identity-attribution
 * grace timer).
 *
 * Boots a real `bootServer` instance on an OS-assigned port with a short
 * `keepaliveGraceMs`, publishes a presence entry, opens a raw WS to
 * `/collab/keepalive?connectionId=<id>`, closes it, and asserts the server's
 * `getPresenceMap()` no longer contains the entry after the grace period.
 *
 * `connectionId` is the unified identifier for both per-agent session cleanup
 * (`closeAllForAgent` + `clearFocus`) and presence cleanup (`clearPresence`).
 *
 * Uses `bootServer` (not the app-package test-harness) because only
 * `bootServer` wires the keepalive-close → grace-timer → cleanup handler
 * (that's the exact wiring under test).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { WebSocket as WsClient } from 'ws';
import { toBroadcasterKey } from './agent-id.ts';
import { type BootedServer, bootServer } from './boot.ts';

async function poll<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  while (!predicate(last) && Date.now() < deadline) {
    await wait(intervalMs);
    last = read();
  }
  return last;
}

async function bootTestServer(
  opts: { keepaliveGraceMs?: number } = {},
): Promise<{ booted: BootedServer; contentDir: string }> {
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-keepalive-test-'));
  writeFileSync(join(contentDir, 'test-doc.md'), '', 'utf-8');
  // Pre-listen check needs <contentDir>/.ok/config.yml present.
  const okDir = join(contentDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(join(okDir, 'config.yml'), '', 'utf-8');
  writeFileSync(join(okDir, '.gitignore'), '', 'utf-8');
  const booted = await bootServer({
    host: '127.0.0.1',
    contentDir,
    attachUiSibling: false,
    idleShutdownMs: null,
    gitEnabled: false,
    quiet: true,
    debounce: 200,
    maxDebounce: 1000,
    keepaliveGraceMs: opts.keepaliveGraceMs ?? 100,
  });
  await booted.ready;
  return { booted, contentDir };
}

async function tearDown({
  booted,
  contentDir,
}: {
  booted: BootedServer;
  contentDir: string;
}): Promise<void> {
  await booted.destroy();
  rmSync(contentDir, { recursive: true, force: true });
}

// Harness registry so `afterAll` can clean up even on test throw.
const servers: Array<{ booted: BootedServer; contentDir: string }> = [];

afterAll(async () => {
  for (const s of servers) {
    try {
      await tearDown(s);
    } catch {
      // best-effort cleanup
    }
  }
});

describe('keepalive WS close → grace timer → clearPresence (US-004)', () => {
  test('closing the keepalive WS clears the presence entry after the grace period', async () => {
    const s = await bootTestServer({ keepaliveGraceMs: 100 });
    servers.push(s);
    const { booted } = s;
    const broadcaster = booted.serverInstance.agentPresenceBroadcaster;
    const connectionId = 'test-agent-close';
    // Seed under the broadcaster-map key (`agent-<connectionId>`), matching
    // how HTTP write handlers store entries via `extractAgentIdentity` →
    // `toBroadcasterKey`. Seeding under the raw URL id would match the bug,
    // not the production flow.
    const presenceKey = toBroadcasterKey(connectionId);

    // Seed the presence entry — something for the WS-close handler to clear.
    broadcaster.setPresence(presenceKey, {
      displayName: 'Claude',
      icon: 'claude',
      color: '#D97757',
      currentDoc: 'foo.md',
      mode: 'idle',
      ts: Date.now(),
    });
    expect(broadcaster.getPresenceMap()[presenceKey]).toBeDefined();

    // Open a real WS to the keepalive endpoint with the matching connectionId.
    const ws = new WsClient(
      `ws://127.0.0.1:${booted.port}/collab/keepalive?pid=${process.pid}&connectionId=${connectionId}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });

    // Close the WS — the server's upgrade handler arms a grace timer
    // (keepaliveGraceMs=100 above), and on expiry it calls clearPresence.
    ws.close();

    // Budget: graceMs (100) + async close + clearPresence dispatch.
    const finalMap = await poll(
      () => broadcaster.getPresenceMap(),
      (map) => !(presenceKey in map),
      1000,
      10,
    );
    expect(finalMap[presenceKey]).toBeUndefined();
  });

  test('reconnect within the grace window cancels the timer (no premature clear)', async () => {
    const s = await bootTestServer({ keepaliveGraceMs: 200 });
    servers.push(s);
    const { booted } = s;
    const broadcaster = booted.serverInstance.agentPresenceBroadcaster;
    const connectionId = 'reconnect-agent';
    const presenceKey = toBroadcasterKey(connectionId);

    broadcaster.setPresence(presenceKey, {
      displayName: 'Claude',
      icon: 'claude',
      color: '#D97757',
      currentDoc: 'foo.md',
      mode: 'idle',
      ts: Date.now(),
    });

    // First connect + close — arms a 200ms grace timer.
    const ws1 = new WsClient(
      `ws://127.0.0.1:${booted.port}/collab/keepalive?pid=${process.pid}&connectionId=${connectionId}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws1.once('open', () => resolve());
      ws1.once('error', (err) => reject(err));
    });
    ws1.close();

    // Reconnect before the grace window expires (~50ms in).
    await wait(50);
    const ws2 = new WsClient(
      `ws://127.0.0.1:${booted.port}/collab/keepalive?pid=${process.pid}&connectionId=${connectionId}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws2.once('open', () => resolve());
      ws2.once('error', (err) => reject(err));
    });

    // Wait past the original grace window. Presence must still be present
    // because the reconnect cancelled the timer.
    await wait(300);
    expect(broadcaster.getPresenceMap()[presenceKey]).toBeDefined();

    ws2.close();
  });

  test('legacy keepalive URL without connectionId does not crash on close', async () => {
    const s = await bootTestServer({ keepaliveGraceMs: 100 });
    servers.push(s);
    const { booted } = s;
    const broadcaster = booted.serverInstance.agentPresenceBroadcaster;

    // Seed an entry so we can confirm it's NOT cleared by the no-id close.
    const survivingAgentKey = toBroadcasterKey('survivor');
    broadcaster.setPresence(survivingAgentKey, {
      displayName: 'Cursor',
      icon: 'cursor',
      color: '#888',
      currentDoc: 'bar.md',
      mode: 'idle',
      ts: Date.now(),
    });

    const ws = new WsClient(`ws://127.0.0.1:${booted.port}/collab/keepalive?pid=${process.pid}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
    ws.close();
    // Give the server a moment past the grace window to confirm no fire.
    await wait(200);
    expect(broadcaster.getPresenceMap()[survivingAgentKey]).toBeDefined();
  });

  test('keepalive ts-refresh timer keeps entry ts fresh during agent idle (≥ 3s)', async () => {
    // Regression: without the server-side ts-refresh timer, an agent
    // between MCP tool calls (LLM thinking for 10-30s) would have its
    // client-visible badge disappear after 5s because the client's TTL
    // filter (AGENT_PRESENCE_STALE_MS) is keyed on entry.ts. The keepalive
    // upgrade handler's 3s bump timer is the server signal that says
    // "this agent's WS is still connected — keep it visible."
    const s = await bootTestServer();
    servers.push(s);
    const { booted } = s;
    const broadcaster = booted.serverInstance.agentPresenceBroadcaster;
    const connectionId = 'test-agent-idle-refresh';
    const presenceKey = toBroadcasterKey(connectionId);

    const ws = new WsClient(
      `ws://127.0.0.1:${booted.port}/collab/keepalive?pid=${process.pid}&connectionId=${connectionId}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });

    // Seed a presence entry with ts=now (simulating a recent agent write).
    const initialTs = Date.now();
    broadcaster.setPresence(presenceKey, {
      displayName: 'Claude',
      icon: 'claude',
      color: '#D97757',
      currentDoc: 'foo.md',
      mode: 'idle',
      ts: initialTs,
    });

    // Wait just past one 3s refresh interval plus a small scheduling
    // margin. The timer should have fired once, bumping ts on an
    // otherwise-idle entry (no agent writes during this window).
    await wait(3_400);

    const bumped = broadcaster.getPresenceMap()[presenceKey];
    expect(bumped).toBeDefined();
    expect(bumped?.ts).toBeGreaterThan(initialTs);
    // Mode is preserved — bumpPresenceTs does NOT flip writing→idle.
    expect(bumped?.mode).toBe('idle');
    // Other fields are preserved.
    expect(bumped?.currentDoc).toBe('foo.md');
    expect(bumped?.displayName).toBe('Claude');

    ws.close();
  });
});
