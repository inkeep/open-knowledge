/**
 * C5: Agent write + concurrent source mode (Y.Text) edits.
 *
 * Symmetric to C4 but validates the Y.Text write surface. Agent writes via
 * the HTTP API use applyAgentMarkdownWrite (XmlFragment-authoritative,
 * precedent #12) which mirrors to Y.Text via applyByPrefixSuffix. Client
 * source-mode edits write directly to Y.Text. The server observer (Observer B
 * under OBSERVER_SYNC_ORIGIN) parses the merged Y.Text and applies to
 * XmlFragment via updateYFragment.
 *
 * Per-test docName isolation via createTestClient/createTestClients.
 * Client lifecycle in try/finally (not afterEach).
 */

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

  // Wait for server observer debounce + WebSocket propagation to settle
  await wait(500);

  // Verify bridge invariant on all clients
  for (const c of clients) {
    assertBridgeInvariant(c.ytext, c.fragment);
  }

  // Verify all clients have identical Y.Text state
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
      // Seed document so the agent's XmlFragment-authoritative read has a base
      await agentWriteMd(server.port, '# C5 Base\n', { docName, position: 'replace' });
      await pollUntil(() => client.ytext.toString().includes('C5 Base'), 5000);
      await wait(500);

      // Client types in source mode (Y.Text)
      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC5-SOURCE-USER-HEADING\n\nUser paragraph.\n');
      });

      // Wait for client's source edit to propagate through server Observer B
      // (Y.Text → XmlFragment) so the agent's XmlFragment-authoritative read
      // sees the client's content
      await pollUntil(
        () => serializeFragment(client.fragment).includes('C5-SOURCE-USER-HEADING'),
        5000,
      );
      await wait(200);

      // Agent write via HTTP API (append)
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
      // Seed content via agent write
      await agentWriteMd(server.port, '# Seed Heading\n\nSeed body text.', {
        docName,
        position: 'replace',
      });
      await pollUntil(() => client.ytext.toString().includes('Seed body text'), 5000);
      await wait(500);

      // Client adds via source mode
      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC5-SEED-SOURCE-ADDITION\n');
      });

      // Wait for source edit to propagate through server bridge
      await pollUntil(
        () => serializeFragment(client.fragment).includes('C5-SEED-SOURCE-ADDITION'),
        5000,
      );
      await wait(200);

      // Agent appends more content
      await agentWriteMd(server.port, '\n\nC5-SEED-AGENT-APPEND\n', {
        docName,
        position: 'append',
      });

      await assertConverged(
        [client],
        ['Seed Heading', 'Seed body text', 'C5-SEED-SOURCE-ADDITION', 'C5-SEED-AGENT-APPEND'],
      );

      // Verify no duplication of seed content
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
      // Client A: source mode edit
      clients[0].doc.transact(() => {
        clients[0].ytext.insert(0, '# C5-MULTI-A\n\n');
      });

      // Client B: source mode edit
      clients[1].doc.transact(() => {
        clients[1].ytext.insert(0, 'C5-MULTI-B\n\n');
      });

      // Wait for client edits to propagate before agent write
      await pollUntil(
        () =>
          clients[0].ytext.toString().includes('C5-MULTI-B') &&
          clients[1].ytext.toString().includes('C5-MULTI-A'),
        5000,
      );
      await wait(400);

      // Agent write via HTTP API
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
      // Agent writes first
      await agentWriteMd(server.port, '# C5-SEQ-AGENT-FIRST\n\nAgent content.', {
        docName,
        position: 'replace',
      });
      await pollUntil(() => client.ytext.toString().includes('C5-SEQ-AGENT-FIRST'), 5000);
      await wait(500);

      // Verify bridge invariant after agent write settles
      assertBridgeInvariant(client.ytext, client.fragment);

      // Client types in source mode after agent write arrived
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
      // Seed first
      await agentWriteMd(server.port, '# Rapid Source Test\n', { docName, position: 'replace' });
      await pollUntil(() => client.ytext.toString().includes('Rapid Source Test'), 5000);
      await wait(500);

      // Client source edit
      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC5-RAPID-SOURCE-0\n');
      });

      // Wait for it to propagate
      await pollUntil(() => serializeFragment(client.fragment).includes('C5-RAPID-SOURCE-0'), 5000);
      await wait(300);

      // Agent appends
      await agentWriteMd(server.port, '\n\nC5-RAPID-AGENT-0\n', { docName, position: 'append' });
      await pollUntil(() => client.ytext.toString().includes('C5-RAPID-AGENT-0'), 5000);
      await wait(300);

      // Second source edit
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
