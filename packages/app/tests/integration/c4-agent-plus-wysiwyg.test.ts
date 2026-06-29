import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
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

function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

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

describe('C4: agent write + concurrent WYSIWYG', () => {
  test('agent write while client types WYSIWYG — both contributions preserved', async () => {
    const docName = `c4-basic-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      appendParagraph(client, 'C4-WYSIWYG-USER-EDIT');

      await agentWriteMd(server.port, '# C4-AGENT-HEADING\n\nC4-agent-body.', {
        docName,
        position: 'append',
      });

      await assertConverged(
        [client],
        ['C4-WYSIWYG-USER-EDIT', 'C4-AGENT-HEADING', 'C4-agent-body'],
      );
    } finally {
      await client.cleanup();
    }
  });

  test('agent write with seed content + WYSIWYG — seed and both edits survive', async () => {
    const docName = `c4-seed-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await agentWriteMd(server.port, '# Existing Document\n\nBase content here.', {
        docName,
        position: 'replace',
      });
      await pollUntil(() => client.ytext.toString().includes('Base content'), 5000);
      await wait(500);

      appendParagraph(client, 'C4-SEED-WYSIWYG-ADDITION');

      await pollUntil(() => client.ytext.toString().includes('C4-SEED-WYSIWYG-ADDITION'), 5000);
      await wait(200);

      await agentWriteMd(server.port, '\n\nC4-SEED-AGENT-APPEND\n', {
        docName,
        position: 'append',
      });

      await assertConverged(
        [client],
        ['Existing Document', 'Base content', 'C4-SEED-WYSIWYG-ADDITION', 'C4-SEED-AGENT-APPEND'],
      );

      const text = client.ytext.toString();
      const seedCount = text.split('Base content').length - 1;
      expect(seedCount).toBe(1);
    } finally {
      await client.cleanup();
    }
  });

  test('agent write + WYSIWYG with two clients — all contributions converge', async () => {
    const docName = `c4-multi-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      appendParagraph(clients[0], 'C4-MULTI-CLIENT-A');

      appendParagraph(clients[1], 'C4-MULTI-CLIENT-B');

      await pollUntil(
        () =>
          clients[0].ytext.toString().includes('C4-MULTI-CLIENT-B') &&
          clients[1].ytext.toString().includes('C4-MULTI-CLIENT-A'),
        5000,
      );
      await wait(400);

      await agentWriteMd(server.port, '\n\nC4-MULTI-AGENT-WRITE\n', {
        docName,
        position: 'append',
      });

      await assertConverged(clients, [
        'C4-MULTI-CLIENT-A',
        'C4-MULTI-CLIENT-B',
        'C4-MULTI-AGENT-WRITE',
      ]);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('sequential agent then WYSIWYG — bridge invariant holds at each step', async () => {
    const docName = `c4-seq-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await agentWriteMd(server.port, '# C4-SEQ-AGENT-FIRST\n\nAgent paragraph.', {
        docName,
        position: 'replace',
      });
      await pollUntil(() => client.ytext.toString().includes('C4-SEQ-AGENT-FIRST'), 5000);
      await wait(500);

      assertBridgeInvariant(client.ytext, client.fragment);

      appendParagraph(client, 'C4-SEQ-WYSIWYG-SECOND');

      await assertConverged(
        [client],
        ['C4-SEQ-AGENT-FIRST', 'Agent paragraph', 'C4-SEQ-WYSIWYG-SECOND'],
      );
    } finally {
      await client.cleanup();
    }
  });

  test('rapid agent writes interleaved with WYSIWYG — no content loss', async () => {
    const docName = `c4-rapid-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await agentWriteMd(server.port, '# Rapid Test\n', { docName, position: 'replace' });
      await pollUntil(() => client.ytext.toString().includes('Rapid Test'), 5000);
      await wait(500);

      appendParagraph(client, 'C4-RAPID-WYSIWYG-0');

      await pollUntil(() => client.ytext.toString().includes('C4-RAPID-WYSIWYG-0'), 5000);
      await wait(300);

      await agentWriteMd(server.port, '\n\nC4-RAPID-AGENT-0\n', { docName, position: 'append' });
      await pollUntil(() => client.ytext.toString().includes('C4-RAPID-AGENT-0'), 5000);
      await wait(300);

      appendParagraph(client, 'C4-RAPID-WYSIWYG-1');

      await assertConverged(
        [client],
        ['Rapid Test', 'C4-RAPID-WYSIWYG-0', 'C4-RAPID-AGENT-0', 'C4-RAPID-WYSIWYG-1'],
      );
    } finally {
      await client.cleanup();
    }
  });
});
