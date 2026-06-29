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

describe('C6: mode-switch mid-debounce', () => {
  test('WYSIWYG edit then immediate source edit — both contributions preserved', async () => {
    const docName = `c6-basic-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      appendParagraph(client, 'C6-WYSIWYG-BEFORE-SWITCH');

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC6-SOURCE-AFTER-SWITCH\n');
      });

      await assertConverged([client], ['C6-WYSIWYG-BEFORE-SWITCH', 'C6-SOURCE-AFTER-SWITCH']);
    } finally {
      await client.cleanup();
    }
  });

  test('WYSIWYG edit, short wait, then source edit — debounce settles correctly', async () => {
    const docName = `c6-short-wait-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      appendParagraph(client, 'C6-WYSIWYG-SHORT');

      await wait(30);

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC6-SOURCE-SHORT\n');
      });

      await assertConverged([client], ['C6-WYSIWYG-SHORT', 'C6-SOURCE-SHORT']);
    } finally {
      await client.cleanup();
    }
  });

  test('WYSIWYG + source switch on seeded document — no seed content loss', async () => {
    const docName = `c6-seeded-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await agentWriteMd(server.port, '# C6 Seeded\n\nExisting content.', {
        docName,
        position: 'replace',
      });
      await pollUntil(() => client.ytext.toString().includes('Existing content'), 5000);
      await wait(500);

      appendParagraph(client, 'C6-SEEDED-WYSIWYG');

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC6-SEEDED-SOURCE\n');
      });

      await assertConverged(
        [client],
        ['C6 Seeded', 'Existing content', 'C6-SEEDED-WYSIWYG', 'C6-SEEDED-SOURCE'],
      );

      const text = client.ytext.toString();
      const seedCount = text.split('Existing content').length - 1;
      expect(seedCount).toBe(1);
    } finally {
      await client.cleanup();
    }
  });

  test('two clients: A switches mode mid-debounce while B types WYSIWYG — convergence', async () => {
    const docName = `c6-two-client-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      appendParagraph(clients[0], 'C6-TWO-A-WYSIWYG');
      clients[0].doc.transact(() => {
        clients[0].ytext.insert(clients[0].ytext.length, '\n\nC6-TWO-A-SOURCE\n');
      });

      appendParagraph(clients[1], 'C6-TWO-B-WYSIWYG');

      await assertConverged(clients, ['C6-TWO-A-WYSIWYG', 'C6-TWO-A-SOURCE', 'C6-TWO-B-WYSIWYG']);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('multiple rapid mode switches — all edits survive', async () => {
    const docName = `c6-rapid-switch-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await agentWriteMd(server.port, '# Rapid Switch\n', { docName, position: 'replace' });
      await pollUntil(() => client.ytext.toString().includes('Rapid Switch'), 5000);
      await wait(500);

      appendParagraph(client, 'C6-RAPID-W1');

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC6-RAPID-S1\n');
      });

      await pollUntil(
        () =>
          client.ytext.toString().includes('C6-RAPID-W1') &&
          serializeFragment(client.fragment).includes('C6-RAPID-S1'),
        5000,
      );
      await wait(300);

      appendParagraph(client, 'C6-RAPID-W2');

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC6-RAPID-S2\n');
      });

      await assertConverged(
        [client],
        ['Rapid Switch', 'C6-RAPID-W1', 'C6-RAPID-S1', 'C6-RAPID-W2', 'C6-RAPID-S2'],
      );
    } finally {
      await client.cleanup();
    }
  });

  test('mode switch with concurrent agent write — all three surfaces converge', async () => {
    const docName = `c6-agent-switch-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await agentWriteMd(server.port, '# Agent Switch Test\n', { docName, position: 'replace' });
      await pollUntil(() => client.ytext.toString().includes('Agent Switch Test'), 5000);
      await wait(500);

      appendParagraph(client, 'C6-AGENT-WYSIWYG');

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC6-AGENT-SOURCE\n');
      });

      await pollUntil(
        () =>
          client.ytext.toString().includes('C6-AGENT-WYSIWYG') &&
          serializeFragment(client.fragment).includes('C6-AGENT-SOURCE'),
        5000,
      );
      await wait(400);

      await agentWriteMd(server.port, '\n\nC6-AGENT-SERVER-WRITE\n', {
        docName,
        position: 'append',
      });

      await assertConverged(
        [client],
        ['Agent Switch Test', 'C6-AGENT-WYSIWYG', 'C6-AGENT-SOURCE', 'C6-AGENT-SERVER-WRITE'],
      );
    } finally {
      await client.cleanup();
    }
  });
});
