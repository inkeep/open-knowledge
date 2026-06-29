import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { WebSocket as WsClient } from 'ws';
import { toBroadcasterKey } from './agent-id.ts';
import { type BootedServer, bootServer } from './boot.ts';
import { parseKeepaliveIdentity } from './mcp-mount.ts';

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

async function bootTestServer(): Promise<{ booted: BootedServer; contentDir: string }> {
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-keepalive-bootstrap-'));
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
    keepaliveGraceMs: 100,
  });
  await booted.ready;
  return { booted, contentDir };
}

const servers: Array<{ booted: BootedServer; contentDir: string }> = [];

afterAll(async () => {
  for (const s of servers) {
    try {
      await s.booted.destroy();
      rmSync(s.contentDir, { recursive: true, force: true });
    } catch {
    }
  }
});

describe('parseKeepaliveIdentity', () => {
  test('returns null when url is undefined', () => {
    expect(parseKeepaliveIdentity(undefined)).toBeNull();
  });

  test('returns null when url is empty string', () => {
    expect(parseKeepaliveIdentity('')).toBeNull();
  });

  test('returns null when no identity params present', () => {
    expect(parseKeepaliveIdentity('/collab/keepalive?connectionId=abc')).toBeNull();
  });

  test('returns null when displayName missing', () => {
    expect(
      parseKeepaliveIdentity('/collab/keepalive?connectionId=abc&clientName=claude&colorSeed=seed'),
    ).toBeNull();
  });

  test('returns null when clientName missing', () => {
    expect(
      parseKeepaliveIdentity(
        '/collab/keepalive?connectionId=abc&displayName=Claude&colorSeed=seed',
      ),
    ).toBeNull();
  });

  test('returns null when colorSeed missing', () => {
    expect(
      parseKeepaliveIdentity(
        '/collab/keepalive?connectionId=abc&displayName=Claude&clientName=claude',
      ),
    ).toBeNull();
  });

  test('returns identity bundle when all three params present', () => {
    expect(
      parseKeepaliveIdentity(
        '/collab/keepalive?connectionId=abc&displayName=Claude&clientName=claude&colorSeed=Claude',
      ),
    ).toEqual({ displayName: 'Claude', clientName: 'claude', colorSeed: 'Claude' });
  });

  test('decodes URL-encoded values (spaces, special chars)', () => {
    expect(
      parseKeepaliveIdentity(
        '/collab/keepalive?connectionId=abc&displayName=Claude%20Code&clientName=claude-code&colorSeed=Claude%20Code',
      ),
    ).toEqual({
      displayName: 'Claude Code',
      clientName: 'claude-code',
      colorSeed: 'Claude Code',
    });
  });

  test('rejects empty string in any field (defense-in-depth)', () => {
    expect(
      parseKeepaliveIdentity(
        '/collab/keepalive?connectionId=abc&displayName=&clientName=claude&colorSeed=Claude',
      ),
    ).toBeNull();
  });

  test('rejects control chars (log-injection / awareness-pollution defense)', () => {
    const dirty =
      '/collab/keepalive?connectionId=abc&displayName=Claude%0D%0Aadmin&clientName=claude&colorSeed=Claude';
    expect(parseKeepaliveIdentity(dirty)).toBeNull();
  });

  test('rejects DEL (0x7f)', () => {
    const dirty =
      '/collab/keepalive?connectionId=abc&displayName=Claude%7F&clientName=claude&colorSeed=Claude';
    expect(parseKeepaliveIdentity(dirty)).toBeNull();
  });

  test('rejects values longer than 256 chars (bounded-cardinality defense)', () => {
    const long = 'a'.repeat(257);
    const dirty = `/collab/keepalive?connectionId=abc&displayName=${long}&clientName=claude&colorSeed=Claude`;
    expect(parseKeepaliveIdentity(dirty)).toBeNull();
  });

  test('accepts values up to 256 chars exactly', () => {
    const just256 = 'a'.repeat(256);
    const url = `/collab/keepalive?connectionId=abc&displayName=${just256}&clientName=claude&colorSeed=Claude`;
    expect(parseKeepaliveIdentity(url)?.displayName).toBe(just256);
  });
});

describe('keepalive WS upgrade → setPresence bootstrap', () => {
  test('opening a keepalive WS with identity params publishes a presence entry', async () => {
    const s = await bootTestServer();
    servers.push(s);
    const { booted } = s;
    const broadcaster = booted.serverInstance.agentPresenceBroadcaster;
    const connectionId = 'bootstrap-claude-code';
    const presenceKey = toBroadcasterKey(connectionId);

    expect(broadcaster.getPresenceMap()[presenceKey]).toBeUndefined();

    const ws = new WsClient(
      `ws://127.0.0.1:${booted.port}/collab/keepalive` +
        `?pid=${process.pid}` +
        `&connectionId=${connectionId}` +
        `&displayName=${encodeURIComponent('Claude')}` +
        `&clientName=${encodeURIComponent('claude-code')}` +
        `&colorSeed=${encodeURIComponent('Claude')}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });

    const map = await poll(
      () => broadcaster.getPresenceMap(),
      (m) => presenceKey in m,
      500,
      10,
    );
    const entry = map[presenceKey];
    expect(entry).toBeDefined();
    expect(entry?.displayName).toBe('Claude');
    expect(typeof entry?.icon).toBe('string');
    expect(entry?.icon.length).toBeGreaterThan(0);
    expect(typeof entry?.color).toBe('string');
    expect(entry?.color.length).toBeGreaterThan(0);
    expect(entry?.currentDoc).toBe('(connected)');
    expect(entry?.mode).toBe('idle');
    expect(entry?.ts).toBeGreaterThan(0);

    ws.close();
  });

  test('legacy keepalive URL without identity params does NOT bootstrap an entry', async () => {
    const s = await bootTestServer();
    servers.push(s);
    const { booted } = s;
    const broadcaster = booted.serverInstance.agentPresenceBroadcaster;
    const connectionId = 'legacy-no-identity';
    const presenceKey = toBroadcasterKey(connectionId);

    const ws = new WsClient(
      `ws://127.0.0.1:${booted.port}/collab/keepalive?pid=${process.pid}&connectionId=${connectionId}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
    await wait(50);
    expect(broadcaster.getPresenceMap()[presenceKey]).toBeUndefined();
    ws.close();
  });

  test('partial identity (clientName missing) does NOT bootstrap an entry', async () => {
    const s = await bootTestServer();
    servers.push(s);
    const { booted } = s;
    const broadcaster = booted.serverInstance.agentPresenceBroadcaster;
    const connectionId = 'partial-identity';
    const presenceKey = toBroadcasterKey(connectionId);

    const ws = new WsClient(
      `ws://127.0.0.1:${booted.port}/collab/keepalive` +
        `?pid=${process.pid}` +
        `&connectionId=${connectionId}` +
        `&displayName=${encodeURIComponent('Claude')}` +
        `&colorSeed=${encodeURIComponent('Claude')}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
    await wait(50);
    expect(broadcaster.getPresenceMap()[presenceKey]).toBeUndefined();
    ws.close();
  });

  test('reconnect during grace window with identity preserves the entry', async () => {
    const s = await bootTestServer();
    servers.push(s);
    const { booted } = s;
    const broadcaster = booted.serverInstance.agentPresenceBroadcaster;
    const connectionId = 'reconnect-bootstrap';
    const presenceKey = toBroadcasterKey(connectionId);
    const baseQuery =
      `?pid=${process.pid}` +
      `&connectionId=${connectionId}` +
      `&displayName=${encodeURIComponent('Claude')}` +
      `&clientName=${encodeURIComponent('claude')}` +
      `&colorSeed=${encodeURIComponent('Claude')}`;

    const ws1 = new WsClient(`ws://127.0.0.1:${booted.port}/collab/keepalive${baseQuery}`);
    await new Promise<void>((resolve, reject) => {
      ws1.once('open', () => resolve());
      ws1.once('error', (err) => reject(err));
    });
    await poll(
      () => broadcaster.getPresenceMap(),
      (m) => presenceKey in m,
      500,
      10,
    );
    expect(broadcaster.getPresenceMap()[presenceKey]).toBeDefined();
    ws1.close();

    await wait(30);
    const ws2 = new WsClient(`ws://127.0.0.1:${booted.port}/collab/keepalive${baseQuery}`);
    await new Promise<void>((resolve, reject) => {
      ws2.once('open', () => resolve());
      ws2.once('error', (err) => reject(err));
    });
    await wait(200);
    expect(broadcaster.getPresenceMap()[presenceKey]).toBeDefined();
    ws2.close();
  });
});
