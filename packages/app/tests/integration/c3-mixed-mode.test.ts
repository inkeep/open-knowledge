
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertBridgeInvariant,
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

describe('C3: mixed-mode concurrent edits', () => {
  test('client A WYSIWYG + client B source — both contributions present', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      appendParagraph(clients[0], 'C3-WYSIWYG-FROM-A');

      clients[1].doc.transact(() => {
        clients[1].ytext.insert(0, 'C3-SOURCE-FROM-B\n\n');
      });

      await assertConverged(clients, ['C3-WYSIWYG-FROM-A', 'C3-SOURCE-FROM-B']);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('WYSIWYG + source with seed content — no content loss', async () => {
    const docName = `c3-seed-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      await agentWriteMd(server.port, '# Shared Base\n\nSeed content.', { docName });
      await pollUntil(() => clients[0].ytext.toString().includes('Seed content'), 5000);
      await pollUntil(() => clients[1].ytext.toString().includes('Seed content'), 5000);
      await wait(500);

      appendParagraph(clients[0], 'C3-MIXED-WYSIWYG');

      await pollUntil(
        () =>
          clients[1].ytext.toString().includes('C3-MIXED-WYSIWYG') &&
          serializeFragment(clients[1].fragment).includes('C3-MIXED-WYSIWYG'),
        5000,
      );
      await wait(200);

      clients[1].doc.transact(() => {
        clients[1].ytext.insert(clients[1].ytext.length, '\n\nC3-MIXED-SOURCE\n');
      });

      await assertConverged(clients, [
        'Shared Base',
        'Seed content',
        'C3-MIXED-WYSIWYG',
        'C3-MIXED-SOURCE',
      ]);

      for (const c of clients) {
        const text = c.ytext.toString();
        const seedCount = text.split('Seed content').length - 1;
        expect(seedCount).toBe(1);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('sequential mixed-mode: WYSIWYG first, then source — bridge invariant holds', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      appendParagraph(clients[0], 'C3-SEQ-WYSIWYG-FIRST');
      await pollUntil(() => clients[1].ytext.toString().includes('C3-SEQ-WYSIWYG-FIRST'), 5000);

      clients[1].doc.transact(() => {
        clients[1].ytext.insert(clients[1].ytext.length, '\n\nC3-SEQ-SOURCE-SECOND\n');
      });

      await assertConverged(clients, ['C3-SEQ-WYSIWYG-FIRST', 'C3-SEQ-SOURCE-SECOND']);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('sequential mixed-mode: source first, then WYSIWYG — bridge invariant holds', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      clients[1].doc.transact(() => {
        clients[1].ytext.insert(0, '# C3-SOURCE-FIRST\n\n');
      });
      await pollUntil(
        () => serializeFragment(clients[0].fragment).includes('C3-SOURCE-FIRST'),
        5000,
      );

      appendParagraph(clients[0], 'C3-WYSIWYG-SECOND');

      await assertConverged(clients, ['C3-SOURCE-FIRST', 'C3-WYSIWYG-SECOND']);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('three clients: two WYSIWYG + one source — all contributions converge', async () => {
    const clients = await createTestClients(server.port, {
      count: 3,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      appendParagraph(clients[0], 'C3-THREE-WYSIWYG-A');

      appendParagraph(clients[1], 'C3-THREE-WYSIWYG-B');

      clients[2].doc.transact(() => {
        clients[2].ytext.insert(0, 'C3-THREE-SOURCE-C\n\n');
      });

      await assertConverged(clients, [
        'C3-THREE-WYSIWYG-A',
        'C3-THREE-WYSIWYG-B',
        'C3-THREE-SOURCE-C',
      ]);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('mixed-mode with agent write — all three write surfaces converge', async () => {
    const docName = `c3-agent-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      appendParagraph(clients[0], 'C3-AGENT-WYSIWYG');

      clients[1].doc.transact(() => {
        clients[1].ytext.insert(0, 'C3-AGENT-SOURCE\n\n');
      });

      await pollUntil(
        () =>
          clients[0].ytext.toString().includes('C3-AGENT-SOURCE') &&
          clients[1].ytext.toString().includes('C3-AGENT-WYSIWYG'),
        5000,
      );
      await wait(400);

      await agentWriteMd(server.port, '\n\nC3-AGENT-SERVER-WRITE\n', {
        docName,
        position: 'append',
      });

      await assertConverged(clients, [
        'C3-AGENT-WYSIWYG',
        'C3-AGENT-SOURCE',
        'C3-AGENT-SERVER-WRITE',
      ]);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
