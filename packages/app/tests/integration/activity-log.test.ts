/**
 * Integration tests for Y.Map('agent-effects') ring-buffer.
 *
 * Verifies that agent writes populate Y.Map('agent-effects') with EffectValue
 * entries, that the ring-buffer eviction caps at 50 entries, and that concurrent
 * sessions produce distinct per-session entries.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { EffectValue } from '../../../../packages/server/src/activity-log.ts';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  type TestServer,
  testReset,
} from './test-harness.ts';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ debounce: 50, maxDebounce: 200 });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('activity-log ring-buffer — agent-effects Y.Map', () => {
  test('agent write populates Y.Map("agent-effects") with correct key/value shape', async () => {
    const docName = `test-${randomUUID()}`;
    await testReset(server.port, docName);
    await wait(200);

    const client = await createTestClient(server.port, docName);
    try {
      // Send raw UUID — extractAgentIdentity prepends 'agent-' making sessionId = `agent-${rawUuid}`
      const rawUuid = randomUUID();
      const expectedSessionId = `agent-${rawUuid}`;
      await agentWriteMd(server.port, '# Hello World', { docName, agentId: rawUuid });
      await wait(400);

      const effectsMap = client.doc.getMap<EffectValue>('agent-effects');
      expect(effectsMap.size).toBeGreaterThanOrEqual(1);

      const entries = [...effectsMap.entries()] as [string, EffectValue][];
      // Find the entry for our expectedSessionId
      const agentEntry = entries.find(([k]) => k.startsWith(`${expectedSessionId}:`));
      if (!agentEntry) throw new Error(`Expected entry for sessionId ${expectedSessionId}`);
      const [key, value] = agentEntry;
      expect(key).toMatch(new RegExp(`^${expectedSessionId}:\\d+$`));
      expect(value.sessionId).toBe(expectedSessionId);
      expect(Array.isArray(value.delta)).toBe(true);
      expect(typeof value.timestamp).toBe('number');
      expect(typeof value.agent_type).toBe('string');
      expect(typeof value.color_seed).toBe('string');
    } finally {
      await client.cleanup();
    }
  });

  test('ring-buffer caps at 50 entries across 60 consecutive writes', async () => {
    const docName = `test-${randomUUID()}`;
    await testReset(server.port, docName);
    await wait(200);

    const client = await createTestClient(server.port, docName);
    try {
      // Make 60 writes from distinct agent IDs (each becomes a captureEffect call)
      for (let i = 0; i < 60; i++) {
        const agentId = `agent-${randomUUID()}`;
        await agentWriteMd(server.port, `# Write ${i}`, { docName, agentId });
      }
      await wait(600);

      const effectsMap = client.doc.getMap<EffectValue>('agent-effects');
      expect(effectsMap.size).toBeLessThanOrEqual(50);
    } finally {
      await client.cleanup();
    }
  });

  test('two sessions produce distinct entries keyed by session ID', async () => {
    const docName = `test-${randomUUID()}`;
    await testReset(server.port, docName);
    await wait(200);

    const client = await createTestClient(server.port, docName);
    try {
      // Send raw UUIDs — extractAgentIdentity prepends 'agent-'
      const rawUuidA = randomUUID();
      const rawUuidB = randomUUID();
      const sessionA = `agent-${rawUuidA}`;
      const sessionB = `agent-${rawUuidB}`;

      await agentWriteMd(server.port, '# Section A', { docName, agentId: rawUuidA });
      await agentWriteMd(server.port, '# Section B', { docName, agentId: rawUuidB });
      await wait(500);

      const effectsMap = client.doc.getMap<EffectValue>('agent-effects');
      const entries = [...effectsMap.entries()] as [string, EffectValue][];

      const entryA = entries.find(([, v]) => v.sessionId === sessionA);
      const entryB = entries.find(([, v]) => v.sessionId === sessionB);

      expect(entryA).toBeDefined();
      expect(entryB).toBeDefined();

      // Keys must be distinct and session-prefixed
      if (!entryA || !entryB) throw new Error('Expected both entries to be defined');
      const [keyA] = entryA;
      const [keyB] = entryB;
      expect(keyA).toMatch(new RegExp(`^${sessionA}:`));
      expect(keyB).toMatch(new RegExp(`^${sessionB}:`));
      expect(keyA).not.toBe(keyB);
    } finally {
      await client.cleanup();
    }
  });
});
