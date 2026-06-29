
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertBridgeInvariant,
  createTestClient,
  createTestClients,
  createTestServer,
  pollUntil,
  serializeFragment,
  type TestClient,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

/** Assert convergence: polls until all markers appear in BOTH Y.Text and
 *  XmlFragment on all clients, then verifies bridge invariant and consistency. */
async function assertConverged(clients: TestClient[], markers: string[]): Promise<void> {
  for (const marker of markers) {
    for (let i = 0; i < clients.length; i++) {
      await pollUntil(
        () =>
          clients[i].ytext.toString().includes(marker) &&
          serializeFragment(clients[i].fragment).includes(marker),
        5000,
      );
    }
  }

  await wait(500);

  for (const c of clients) {
    assertBridgeInvariant(c.ytext, c.fragment);
  }

  const ytexts = clients.map((c) => c.ytext.toString());
  for (let i = 1; i < ytexts.length; i++) {
    expect(ytexts[i]).toBe(ytexts[0]);
  }
}

describe('C5: agent write + concurrent source mode', () => {
  test('agent write while client types in source — both contributions preserved', async () => {
    const docName = `c5-basic-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await agentWriteMd(server.port, '# C5 Base\n', { docName, position: 'replace' });
      await pollUntil(() => client.ytext.toString().includes('C5 Base'), 5000);
      await wait(500);

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC5-SOURCE-USER-HEADING\n\nUser paragraph.\n');
      });

      await pollUntil(
        () => serializeFragment(client.fragment).includes('C5-SOURCE-USER-HEADING'),
        5000,
      );
      await wait(200);

      await agentWriteMd(server.port, '\n\nC5-AGENT-CONTENT\n', {
        docName,
        position: 'append',
      });

      await assertConverged(
        [client],
        ['C5-SOURCE-USER-HEADING', 'User paragraph', 'C5-AGENT-CONTENT'],
      );
    } finally {
      await client.cleanup();
    }
  });

  test('agent write with seed content + source edit — seed and both edits survive', async () => {
    const docName = `c5-seed-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await agentWriteMd(server.port, '# Seed Heading\n\nSeed body text.', {
        docName,
        position: 'replace',
      });
      await pollUntil(() => client.ytext.toString().includes('Seed body text'), 5000);
      await wait(500);

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC5-SEED-SOURCE-ADDITION\n');
      });

      await pollUntil(
        () => serializeFragment(client.fragment).includes('C5-SEED-SOURCE-ADDITION'),
        5000,
      );
      await wait(200);

      await agentWriteMd(server.port, '\n\nC5-SEED-AGENT-APPEND\n', {
        docName,
        position: 'append',
      });

      await assertConverged(
        [client],
        ['Seed Heading', 'Seed body text', 'C5-SEED-SOURCE-ADDITION', 'C5-SEED-AGENT-APPEND'],
      );

      const text = client.ytext.toString();
      const seedCount = text.split('Seed body text').length - 1;
      expect(seedCount).toBe(1);
    } finally {
      await client.cleanup();
    }
  });

  test('agent write + source mode with two clients — all contributions converge', async () => {
    const docName = `c5-multi-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      clients[0].doc.transact(() => {
        clients[0].ytext.insert(0, '# C5-MULTI-A\n\n');
      });

      clients[1].doc.transact(() => {
        clients[1].ytext.insert(0, 'C5-MULTI-B\n\n');
      });

      await pollUntil(
        () =>
          clients[0].ytext.toString().includes('C5-MULTI-B') &&
          clients[1].ytext.toString().includes('C5-MULTI-A'),
        5000,
      );
      await wait(400);

      await agentWriteMd(server.port, '\n\nC5-MULTI-AGENT\n', {
        docName,
        position: 'append',
      });

      await assertConverged(clients, ['C5-MULTI-A', 'C5-MULTI-B', 'C5-MULTI-AGENT']);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('sequential agent then source — bridge invariant holds at each step', async () => {
    const docName = `c5-seq-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await agentWriteMd(server.port, '# C5-SEQ-AGENT-FIRST\n\nAgent content.', {
        docName,
        position: 'replace',
      });
      await pollUntil(() => client.ytext.toString().includes('C5-SEQ-AGENT-FIRST'), 5000);
      await wait(500);

      assertBridgeInvariant(client.ytext, client.fragment);

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC5-SEQ-SOURCE-SECOND\n');
      });

      await assertConverged(
        [client],
        ['C5-SEQ-AGENT-FIRST', 'Agent content', 'C5-SEQ-SOURCE-SECOND'],
      );
    } finally {
      await client.cleanup();
    }
  });

  test('rapid agent writes interleaved with source edits — no content loss', async () => {
    const docName = `c5-rapid-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await agentWriteMd(server.port, '# Rapid Source Test\n', { docName, position: 'replace' });
      await pollUntil(() => client.ytext.toString().includes('Rapid Source Test'), 5000);
      await wait(500);

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC5-RAPID-SOURCE-0\n');
      });

      await pollUntil(() => serializeFragment(client.fragment).includes('C5-RAPID-SOURCE-0'), 5000);
      await wait(300);

      await agentWriteMd(server.port, '\n\nC5-RAPID-AGENT-0\n', { docName, position: 'append' });
      await pollUntil(() => client.ytext.toString().includes('C5-RAPID-AGENT-0'), 5000);
      await wait(300);

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC5-RAPID-SOURCE-1\n');
      });

      await assertConverged(
        [client],
        ['Rapid Source Test', 'C5-RAPID-SOURCE-0', 'C5-RAPID-AGENT-0', 'C5-RAPID-SOURCE-1'],
      );
    } finally {
      await client.cleanup();
    }
  });
});
