/**
 * C7: Disconnect-reconnect burst — paused sync clients rejoin simultaneously.
 *
 * Validates that multiple clients who pause inbound CRDT sync (simulating
 * network disconnection), make local edits while paused, and then resume
 * simultaneously, converge correctly. The server-authoritative observer bridge
 * handles the merged result under OBSERVER_SYNC_ORIGIN.
 *
 * Uses ControllableWebSocket via `syncControl: true` for pause/resume.
 * Per-test docName isolation. Client lifecycle in try/finally.
 */

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

describe('C7: disconnect-reconnect burst', () => {
  test('two clients pause, edit locally, resume — both edits preserved', async () => {
    const docName = `c7-basic-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true, syncControl: true },
    });
    try {
      // Both clients pause inbound sync (simulating disconnection)
      clients[0].pauseSync();
      clients[1].pauseSync();

      // Each client makes local WYSIWYG edits while "disconnected"
      appendParagraph(clients[0], 'C7-DISCONNECTED-A');
      appendParagraph(clients[1], 'C7-DISCONNECTED-B');

      // Small delay to let outbound messages reach the server
      await wait(200);

      // Both resume simultaneously
      clients[0].resumeSync();
      clients[1].resumeSync();

      await assertConverged(clients, ['C7-DISCONNECTED-A', 'C7-DISCONNECTED-B']);

      // Verify no duplication
      for (const c of clients) {
        const text = c.ytext.toString();
        expect(text.split('C7-DISCONNECTED-A').length - 1).toBe(1);
        expect(text.split('C7-DISCONNECTED-B').length - 1).toBe(1);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('three clients disconnect-reconnect with seeded content — seed + all edits survive', async () => {
    const docName = `c7-seeded-${crypto.randomUUID()}`;

    // Seed content via agent API (no separate client needed)
    await agentWriteMd(server.port, '# C7 Seeded Doc\n\nBase content here.', {
      docName,
      position: 'replace',
    });
    // Let agent write settle on server before clients connect
    await wait(500);

    // Create sync-controlled clients
    const clients = await createTestClients(server.port, {
      count: 3,
      docName,
      perClientOptions: { skipInvariantWatcher: true, syncControl: true },
    });
    try {
      // Wait for seed to arrive on all clients
      for (const c of clients) {
        await pollUntil(() => c.ytext.toString().includes('Base content'), 5000);
      }
      await wait(300);

      // All three clients pause
      for (const c of clients) c.pauseSync();

      // Each edits locally
      appendParagraph(clients[0], 'C7-SEEDED-EDIT-A');
      appendParagraph(clients[1], 'C7-SEEDED-EDIT-B');
      appendParagraph(clients[2], 'C7-SEEDED-EDIT-C');

      // Let outbound reach server
      await wait(200);

      // All resume
      for (const c of clients) c.resumeSync();

      await assertConverged(clients, [
        'C7 Seeded Doc',
        'Base content',
        'C7-SEEDED-EDIT-A',
        'C7-SEEDED-EDIT-B',
        'C7-SEEDED-EDIT-C',
      ]);

      // No duplication of seed content
      for (const c of clients) {
        const text = c.ytext.toString();
        expect(text.split('Base content').length - 1).toBe(1);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('client pauses, agent writes, client resumes — both contributions merged', async () => {
    const docName = `c7-agent-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, {
      skipInvariantWatcher: true,
      syncControl: true,
    });
    try {
      // Seed content
      await agentWriteMd(server.port, '# C7 Agent Test\n\nInitial.', {
        docName,
        position: 'replace',
      });
      await pollUntil(() => client.ytext.toString().includes('Initial'), 5000);
      await wait(500);

      // Client pauses inbound sync
      client.pauseSync();

      // Client edits locally while paused
      appendParagraph(client, 'C7-AGENT-CLIENT-EDIT');

      // Agent writes on server while client is paused
      await agentWriteMd(server.port, '\n\nC7-AGENT-SERVER-EDIT\n', {
        docName,
        position: 'append',
      });

      // Let server process agent write
      await wait(300);

      // Client resumes — should merge server agent write + client local edit
      client.resumeSync();

      await assertConverged(
        [client],
        ['C7 Agent Test', 'Initial', 'C7-AGENT-CLIENT-EDIT', 'C7-AGENT-SERVER-EDIT'],
      );
    } finally {
      await client.cleanup();
    }
  });

  test('staggered resume — clients resume one at a time with delay between', async () => {
    const docName = `c7-stagger-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 3,
      docName,
      perClientOptions: { skipInvariantWatcher: true, syncControl: true },
    });
    try {
      // All pause
      for (const c of clients) c.pauseSync();

      // Each edits
      appendParagraph(clients[0], 'C7-STAGGER-A');
      appendParagraph(clients[1], 'C7-STAGGER-B');
      appendParagraph(clients[2], 'C7-STAGGER-C');

      await wait(200);

      // Staggered resume: A first, then B, then C
      clients[0].resumeSync();
      await wait(200);
      clients[1].resumeSync();
      await wait(200);
      clients[2].resumeSync();

      await assertConverged(clients, ['C7-STAGGER-A', 'C7-STAGGER-B', 'C7-STAGGER-C']);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('pause-edit-resume cycle repeated twice — no content loss across cycles', async () => {
    const docName = `c7-repeat-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true, syncControl: true },
    });
    try {
      // --- Cycle 1 ---
      for (const c of clients) c.pauseSync();

      appendParagraph(clients[0], 'C7-CYCLE1-A');
      appendParagraph(clients[1], 'C7-CYCLE1-B');

      await wait(200);
      for (const c of clients) c.resumeSync();

      await assertConverged(clients, ['C7-CYCLE1-A', 'C7-CYCLE1-B']);

      // --- Cycle 2 ---
      for (const c of clients) c.pauseSync();

      appendParagraph(clients[0], 'C7-CYCLE2-A');
      appendParagraph(clients[1], 'C7-CYCLE2-B');

      await wait(200);
      for (const c of clients) c.resumeSync();

      await assertConverged(clients, ['C7-CYCLE1-A', 'C7-CYCLE1-B', 'C7-CYCLE2-A', 'C7-CYCLE2-B']);

      // No duplication from either cycle
      for (const c of clients) {
        const text = c.ytext.toString();
        expect(text.split('C7-CYCLE1-A').length - 1).toBe(1);
        expect(text.split('C7-CYCLE2-A').length - 1).toBe(1);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
