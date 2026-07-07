/**
 * C3: Mixed-mode concurrent edits — WYSIWYG + source mode convergence.
 *
 * Validates that Client A editing in WYSIWYG (XmlFragment writes) and
 * Client B editing in source mode (Y.Text writes) converge correctly
 * under the server-authoritative observer bridge. The server observer
 * handles all cross-CRDT writes under OBSERVER_SYNC_ORIGIN — client
 * observers no longer perform cross-representation writes.
 *
 * Per-test docName isolation via createTestClients(port, { count }) default.
 * Client lifecycle in try/finally (not afterEach).
 */

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

/** Append a paragraph with the given text to a client's XmlFragment. */
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
  // Wait until all markers appear in Y.Text AND XmlFragment on all clients
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

describe('C3: mixed-mode concurrent edits', () => {
  test('client A WYSIWYG + client B source — both contributions present', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      // Client A writes via XmlFragment (WYSIWYG)
      appendParagraph(clients[0], 'C3-WYSIWYG-FROM-A');

      // Client B writes via Y.Text (source mode)
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
      // Seed via agent write
      await agentWriteMd(server.port, '# Shared Base\n\nSeed content.', { docName });
      await pollUntil(() => clients[0].ytext.toString().includes('Seed content'), 5000);
      await pollUntil(() => clients[1].ytext.toString().includes('Seed content'), 5000);
      // Wait for bridge to fully settle before client edits
      await wait(500);

      // Client A adds via WYSIWYG
      appendParagraph(clients[0], 'C3-MIXED-WYSIWYG');

      // Wait for A's WYSIWYG edit to fully propagate through the server
      // observer bridge (XmlFragment → Y.Text) and back to Client B,
      // ensuring the bridge has settled before B's source-mode write.
      await pollUntil(
        () =>
          clients[1].ytext.toString().includes('C3-MIXED-WYSIWYG') &&
          serializeFragment(clients[1].fragment).includes('C3-MIXED-WYSIWYG'),
        5000,
      );
      // Give the server observer one more debounce cycle to fully settle
      await wait(200);

      // Client B adds via source mode after bridge is settled
      clients[1].doc.transact(() => {
        clients[1].ytext.insert(clients[1].ytext.length, '\n\nC3-MIXED-SOURCE\n');
      });

      await assertConverged(clients, [
        'Shared Base',
        'Seed content',
        'C3-MIXED-WYSIWYG',
        'C3-MIXED-SOURCE',
      ]);

      // Verify seed content appears exactly once (no duplication)
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
      // Client A writes via WYSIWYG first
      appendParagraph(clients[0], 'C3-SEQ-WYSIWYG-FIRST');
      await pollUntil(() => clients[1].ytext.toString().includes('C3-SEQ-WYSIWYG-FIRST'), 5000);

      // Client B writes via source mode after A's edit arrived
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
      // Client B writes via source mode first
      clients[1].doc.transact(() => {
        clients[1].ytext.insert(0, '# C3-SOURCE-FIRST\n\n');
      });
      await pollUntil(
        () => serializeFragment(clients[0].fragment).includes('C3-SOURCE-FIRST'),
        5000,
      );

      // Client A writes via WYSIWYG after B's edit arrived
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
      // Client A: WYSIWYG
      appendParagraph(clients[0], 'C3-THREE-WYSIWYG-A');

      // Client B: WYSIWYG
      appendParagraph(clients[1], 'C3-THREE-WYSIWYG-B');

      // Client C: source mode
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
      // Client A: WYSIWYG
      appendParagraph(clients[0], 'C3-AGENT-WYSIWYG');

      // Client B: source mode
      clients[1].doc.transact(() => {
        clients[1].ytext.insert(0, 'C3-AGENT-SOURCE\n\n');
      });

      // Wait for client edits to propagate before agent write
      await pollUntil(
        () =>
          clients[0].ytext.toString().includes('C3-AGENT-SOURCE') &&
          clients[1].ytext.toString().includes('C3-AGENT-WYSIWYG'),
        5000,
      );
      await wait(400);

      // Agent write via HTTP API
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
