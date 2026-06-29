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

const servers: Array<{ booted: BootedServer; contentDir: string }> = [];

afterAll(async () => {
  for (const s of servers) {
    try {
      await tearDown(s);
    } catch {}
  }
});

describe('keepalive WS close → grace timer → clearPresence (US-004)', () => {
  test('closing the keepalive WS clears the presence entry after the grace period', async () => {
    const s = await bootTestServer({ keepaliveGraceMs: 100 });
    servers.push(s);
    const { booted } = s;
    const broadcaster = booted.serverInstance.agentPresenceBroadcaster;
    const connectionId = 'test-agent-close';
    const presenceKey = toBroadcasterKey(connectionId);

    broadcaster.setPresence(presenceKey, {
      displayName: 'Claude',
      icon: 'claude',
      color: '#D97757',
      currentDoc: 'foo.md',
      mode: 'idle',
      ts: Date.now(),
    });
    expect(broadcaster.getPresenceMap()[presenceKey]).toBeDefined();

    const ws = new WsClient(
      `ws://127.0.0.1:${booted.port}/collab/keepalive?pid=${process.pid}&connectionId=${connectionId}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });

    ws.close();

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

    const ws1 = new WsClient(
      `ws://127.0.0.1:${booted.port}/collab/keepalive?pid=${process.pid}&connectionId=${connectionId}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws1.once('open', () => resolve());
      ws1.once('error', (err) => reject(err));
    });
    ws1.close();

    await wait(50);
    const ws2 = new WsClient(
      `ws://127.0.0.1:${booted.port}/collab/keepalive?pid=${process.pid}&connectionId=${connectionId}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws2.once('open', () => resolve());
      ws2.once('error', (err) => reject(err));
    });

    await wait(300);
    expect(broadcaster.getPresenceMap()[presenceKey]).toBeDefined();

    ws2.close();
  });

  test('legacy keepalive URL without connectionId does not crash on close', async () => {
    const s = await bootTestServer({ keepaliveGraceMs: 100 });
    servers.push(s);
    const { booted } = s;
    const broadcaster = booted.serverInstance.agentPresenceBroadcaster;

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
    await wait(200);
    expect(broadcaster.getPresenceMap()[survivingAgentKey]).toBeDefined();
  });

  test('keepalive ts-refresh timer keeps entry ts fresh during agent idle (≥ 3s)', async () => {
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

    const initialTs = Date.now();
    broadcaster.setPresence(presenceKey, {
      displayName: 'Claude',
      icon: 'claude',
      color: '#D97757',
      currentDoc: 'foo.md',
      mode: 'idle',
      ts: initialTs,
    });

    await wait(3_400);

    const bumped = broadcaster.getPresenceMap()[presenceKey];
    expect(bumped).toBeDefined();
    expect(bumped?.ts).toBeGreaterThan(initialTs);
    expect(bumped?.mode).toBe('idle');
    expect(bumped?.currentDoc).toBe('foo.md');
    expect(bumped?.displayName).toBe('Claude');

    ws.close();
  });
});
