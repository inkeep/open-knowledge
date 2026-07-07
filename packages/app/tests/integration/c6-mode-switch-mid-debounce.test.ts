/**
 * C6: Mode-switch mid-debounce — WYSIWYG → source transition timing.
 *
 * Validates that a client switching from WYSIWYG mode (XmlFragment writes) to
 * source mode (Y.Text writes) while the server has pending observer debounces
 * does not produce races or content loss. Under the server-authoritative bridge,
 * the server observer handles all cross-CRDT writes: Observer A (XmlFragment →
 * Y.Text) debounces at 50ms, and Observer B (Y.Text → XmlFragment) debounces
 * at 50ms with typing-defer at 300ms.
 *
 * The key timing interaction: a WYSIWYG edit fires server Observer A's debounce.
 * If the client then immediately writes to Y.Text (source mode), the debounced
 * Observer A fires after the source write is already in Y.Text. The server must
 * produce a final state containing contributions from both modes.
 *
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

describe('C6: mode-switch mid-debounce', () => {
  test('WYSIWYG edit then immediate source edit — both contributions preserved', async () => {
    const docName = `c6-basic-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      // Client types in WYSIWYG (fires server Observer A debounce)
      appendParagraph(client, 'C6-WYSIWYG-BEFORE-SWITCH');

      // Immediately switch to source mode and write to Y.Text
      // This arrives while server Observer A's 50ms debounce is still pending
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
      // Client types in WYSIWYG
      appendParagraph(client, 'C6-WYSIWYG-SHORT');

      // Wait less than the server observer debounce (50ms) to simulate
      // a fast mode switch — the WYSIWYG edit's observer debounce
      // may or may not have fired
      await wait(30);

      // Switch to source mode
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
      // Seed content
      await agentWriteMd(server.port, '# C6 Seeded\n\nExisting content.', {
        docName,
        position: 'replace',
      });
      await pollUntil(() => client.ytext.toString().includes('Existing content'), 5000);
      await wait(500);

      // Client edits in WYSIWYG
      appendParagraph(client, 'C6-SEEDED-WYSIWYG');

      // Immediate mode switch to source
      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC6-SEEDED-SOURCE\n');
      });

      await assertConverged(
        [client],
        ['C6 Seeded', 'Existing content', 'C6-SEEDED-WYSIWYG', 'C6-SEEDED-SOURCE'],
      );

      // Verify seed content not duplicated
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
      // Client A: WYSIWYG edit then mode switch to source
      appendParagraph(clients[0], 'C6-TWO-A-WYSIWYG');
      clients[0].doc.transact(() => {
        clients[0].ytext.insert(clients[0].ytext.length, '\n\nC6-TWO-A-SOURCE\n');
      });

      // Client B: concurrent WYSIWYG edit
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
      // Seed
      await agentWriteMd(server.port, '# Rapid Switch\n', { docName, position: 'replace' });
      await pollUntil(() => client.ytext.toString().includes('Rapid Switch'), 5000);
      await wait(500);

      // WYSIWYG → source → WYSIWYG → source in quick succession
      appendParagraph(client, 'C6-RAPID-W1');

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC6-RAPID-S1\n');
      });

      // Let the server observer process the first round
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
      // Seed
      await agentWriteMd(server.port, '# Agent Switch Test\n', { docName, position: 'replace' });
      await pollUntil(() => client.ytext.toString().includes('Agent Switch Test'), 5000);
      await wait(500);

      // Client WYSIWYG edit (fires server observer debounce)
      appendParagraph(client, 'C6-AGENT-WYSIWYG');

      // Immediate mode switch to source
      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\n\nC6-AGENT-SOURCE\n');
      });

      // Wait for client edits to propagate
      await pollUntil(
        () =>
          client.ytext.toString().includes('C6-AGENT-WYSIWYG') &&
          serializeFragment(client.fragment).includes('C6-AGENT-SOURCE'),
        5000,
      );
      await wait(400);

      // Agent write while client has already switched modes
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
