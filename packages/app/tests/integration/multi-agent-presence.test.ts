
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { toBroadcasterKey } from '@inkeep/open-knowledge-server';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { agentWriteMd, createTestServer, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('multi-agent presence — Tier 1 regression gate (FR-8)', () => {
  test('two agents on the same doc coexist as distinct presence entries', async () => {
    const doc = `mp-same-doc-${crypto.randomUUID().slice(0, 8)}`;
    const uuidA = `uuid-a-${crypto.randomUUID().slice(0, 8)}`;
    const uuidB = `uuid-b-${crypto.randomUUID().slice(0, 8)}`;

    await agentWriteMd(server.port, '# Claude was here', {
      docName: doc,
      position: 'replace',
      agentId: uuidA,
      agentName: 'Claude',
      clientName: 'claude-code',
    });
    await agentWriteMd(server.port, '# Cursor was here', {
      docName: doc,
      position: 'append',
      agentId: uuidB,
      agentName: 'Cursor',
      clientName: 'cursor',
    });

    const keyA = toBroadcasterKey(uuidA);
    const keyB = toBroadcasterKey(uuidB);
    const map = server.instance.agentPresenceBroadcaster.getPresenceMap();
    expect(map[keyA]).toBeDefined();
    expect(map[keyB]).toBeDefined();

    expect(map[keyA].displayName).toBe('Claude');
    expect(map[keyA].icon).toBe('claude');
    expect(map[keyA].currentDoc).toBe(doc);
    expect(map[keyA].mode).toBe('idle');
    expect(typeof map[keyA].color).toBe('string');
    expect(map[keyA].color.length).toBeGreaterThan(0);

    expect(map[keyB].displayName).toBe('Cursor');
    expect(map[keyB].icon).toBe('cursor');
    expect(map[keyB].currentDoc).toBe(doc);
    expect(map[keyB].mode).toBe('idle');

    expect(map[keyB].ts).toBeGreaterThanOrEqual(map[keyA].ts);
  });

  test("agent moves to a different doc — their currentDoc updates, other agent's stays", async () => {
    const docFoo = `mp-foo-${crypto.randomUUID().slice(0, 8)}`;
    const docBar = `mp-bar-${crypto.randomUUID().slice(0, 8)}`;
    const uuidA = `uuid-a-${crypto.randomUUID().slice(0, 8)}`;
    const uuidB = `uuid-b-${crypto.randomUUID().slice(0, 8)}`;

    await agentWriteMd(server.port, '# A on foo', {
      docName: docFoo,
      position: 'replace',
      agentId: uuidA,
      agentName: 'Claude',
      clientName: 'claude-code',
    });
    await agentWriteMd(server.port, '# B on foo', {
      docName: docFoo,
      position: 'append',
      agentId: uuidB,
      agentName: 'Cursor',
      clientName: 'cursor',
    });

    await agentWriteMd(server.port, '# B on bar', {
      docName: docBar,
      position: 'replace',
      agentId: uuidB,
      agentName: 'Cursor',
      clientName: 'cursor',
    });

    const map = server.instance.agentPresenceBroadcaster.getPresenceMap();
    expect(map[toBroadcasterKey(uuidA)].currentDoc).toBe(docFoo);
    expect(map[toBroadcasterKey(uuidB)].currentDoc).toBe(docBar);
  });

  test('handleAgentWrite (simple /api/agent-write variant) publishes presence — closes pre-existing gap', async () => {
    const doc = `mp-simple-${crypto.randomUUID().slice(0, 8)}`;
    const uuid = `uuid-simple-${crypto.randomUUID().slice(0, 8)}`;

    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'hello from the simple handler',
        docName: doc,
        agentId: uuid,
        agentName: 'Claude',
        clientName: 'claude-code',
      }),
    });
    expect(res.ok).toBe(true);

    const key = toBroadcasterKey(uuid);
    const map = server.instance.agentPresenceBroadcaster.getPresenceMap();
    expect(map[key]).toBeDefined();
    expect(map[key].displayName).toBe('Claude');
    expect(map[key].icon).toBe('claude');
    expect(map[key].currentDoc).toBe(doc);
    expect(map[key].mode).toBe('idle');
  });

  test('GET /api/metrics/agent-presence returns the broadcaster map', async () => {
    const doc = `mp-metrics-${crypto.randomUUID().slice(0, 8)}`;
    const uuid = `uuid-metrics-${crypto.randomUUID().slice(0, 8)}`;

    await agentWriteMd(server.port, '# metrics probe', {
      docName: doc,
      position: 'replace',
      agentId: uuid,
      agentName: 'Claude',
      clientName: 'claude-code',
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/agent-presence`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      presence: Record<
        string,
        {
          displayName: string;
          icon: string;
          color: string;
          currentDoc: string | null;
          mode: string;
          ts: number;
        }
      >;
    };
    const key = toBroadcasterKey(uuid);
    expect(body.presence[key]).toBeDefined();
    expect(body.presence[key].displayName).toBe('Claude');
    expect(body.presence[key].currentDoc).toBe(doc);
  });

  test('GET /api/metrics/agent-presence rejects DNS-rebinding Host with 403 (RFC 9457)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/agent-presence`, {
      headers: { Host: 'attacker.example.com' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.status).toBe(403);
  });
});
