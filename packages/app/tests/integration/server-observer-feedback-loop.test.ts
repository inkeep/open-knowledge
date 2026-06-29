import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { getMetrics, resetMetrics } from '@inkeep/open-knowledge-server';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterEach(() => {
  resetMetrics();
});

describe('Mutation F gate: OBSERVER_SYNC_ORIGIN.skipStoreHooks=true prevents disk-write amplification', () => {
  test('single agent-write produces exactly 1 persistence disk write (no observer amplification)', async () => {
    const docName = `mf-gate-${crypto.randomUUID()}`;
    const marker = 'MF-single-agent-write-marker';

    const client = await createTestClient(server.port, docName);
    try {
      await wait(500);
      resetMetrics();

      await agentWriteMd(server.port, `# ${marker}\n\nBody text.\n`, {
        docName,
        position: 'replace',
      });

      await pollUntil(() => client.ytext.toString().includes(marker), 5000);
      await wait(500);

      const { persistenceDiskWrites, serverObserverFiresA, serverObserverFiresB } = getMetrics();

      expect(persistenceDiskWrites).toBe(1);

      expect(serverObserverFiresA).toBeLessThanOrEqual(3);
      expect(serverObserverFiresB).toBeLessThanOrEqual(3);
    } finally {
      client.cleanup();
    }
  }, 30_000);

  test('three sequential agent-writes produce exactly 3 persistence disk writes (no compounding)', async () => {
    const docName = `mf-gate-seq-${crypto.randomUUID()}`;

    const client = await createTestClient(server.port, docName);
    try {
      await wait(500);
      resetMetrics();

      for (let i = 0; i < 3; i++) {
        const marker = `MF-seq-edit-${i}`;
        await agentWriteMd(server.port, `# ${marker}\n\nEdit ${i}.\n`, {
          docName,
          position: 'replace',
        });
        await pollUntil(() => client.ytext.toString().includes(marker), 3000);
        await wait(400);
      }

      await wait(300);

      const { persistenceDiskWrites } = getMetrics();
      expect(persistenceDiskWrites).toBe(3);
    } finally {
      client.cleanup();
    }
  }, 30_000);
});
