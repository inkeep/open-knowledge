/**
 * C8: Triple concurrent write surfaces — file-watcher + agent + WYSIWYG.
 *
 * Validates that three independent write surfaces firing concurrently all
 * survive the server-authoritative observer bridge:
 *   1. File-watcher external change (writeFileSync to contentDir)
 *   2. Agent write via HTTP API (agentWriteMd)
 *   3. Human WYSIWYG typing via XmlFragment mutation
 *
 * Each test seeds initial content, then applies three independent changes
 * with distinct markers to verify full-body preservation. The server observer
 * handles cross-CRDT writes under OBSERVER_SYNC_ORIGIN.
 *
 * Per-test docName isolation. Client lifecycle in try/finally.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  readTestDoc,
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
        8000,
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

describe('C8: triple concurrent write surfaces', () => {
  test('file-watcher + agent + WYSIWYG — all three contributions preserved', async () => {
    // Use a known docName that maps to a file on disk.
    // Seed the file first so the doc exists in the watcher index.
    const docName = `c8-triple-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, '# C8 Triple Test\n\nSeed content.\n', 'utf-8');

    // Wait for file watcher to index the new file
    await wait(500);

    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      // Wait for seed content to arrive
      await pollUntil(() => client.ytext.toString().includes('Seed content'), 5000);
      await wait(500);

      // Now fire all three write surfaces concurrently:

      // 1. Human WYSIWYG typing via XmlFragment
      appendParagraph(client, 'C8-HUMAN-WYSIWYG-CONTENT');

      // 2. Agent write via HTTP API
      await agentWriteMd(server.port, '\n\nC8-AGENT-API-CONTENT\n', {
        docName,
        position: 'append',
      });

      // Wait for agent + WYSIWYG to settle before file-watcher write,
      // because file-watcher triggers a full external-change reconciliation
      // that is most meaningful after the CRDT has partial content.
      await pollUntil(
        () =>
          client.ytext.toString().includes('C8-HUMAN-WYSIWYG-CONTENT') &&
          client.ytext.toString().includes('C8-AGENT-API-CONTENT'),
        5000,
      );
      await wait(300);

      // 3. File-watcher external change (append to the file on disk)
      const currentDisk = readTestDoc(server.contentDir, docName);
      writeFileSync(filePath, `${currentDisk}\nC8-FILE-WATCHER-CONTENT\n`, 'utf-8');

      // Wait for file watcher to detect the change and propagate
      await pollUntil(() => client.ytext.toString().includes('C8-FILE-WATCHER-CONTENT'), 8000);

      await assertConverged(
        [client],
        [
          'C8 Triple Test',
          'Seed content',
          'C8-HUMAN-WYSIWYG-CONTENT',
          'C8-AGENT-API-CONTENT',
          'C8-FILE-WATCHER-CONTENT',
        ],
      );

      // No duplication of seed content
      const text = client.ytext.toString();
      expect(text.split('Seed content').length - 1).toBe(1);
    } finally {
      await client.cleanup();
    }
  });

  test('file-watcher + agent + WYSIWYG with two clients — convergence across all', async () => {
    const docName = `c8-multi-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, '# C8 Multi-Client\n\nBase.\n', 'utf-8');
    await wait(500);

    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      // Wait for seed content
      for (const c of clients) {
        await pollUntil(() => c.ytext.toString().includes('Base'), 5000);
      }
      await wait(500);

      // Client A: WYSIWYG edit
      appendParagraph(clients[0], 'C8-MULTI-WYSIWYG-FROM-A');

      // Agent write
      await agentWriteMd(server.port, '\n\nC8-MULTI-AGENT-WRITE\n', {
        docName,
        position: 'append',
      });

      // Wait for CRDT edits to settle before disk write
      await pollUntil(
        () =>
          clients[0].ytext.toString().includes('C8-MULTI-AGENT-WRITE') &&
          clients[1].ytext.toString().includes('C8-MULTI-WYSIWYG-FROM-A'),
        5000,
      );
      await wait(300);

      // File-watcher external change
      const currentDisk = readTestDoc(server.contentDir, docName);
      writeFileSync(filePath, `${currentDisk}\nC8-MULTI-FILE-WATCHER\n`, 'utf-8');

      await assertConverged(clients, [
        'C8 Multi-Client',
        'C8-MULTI-WYSIWYG-FROM-A',
        'C8-MULTI-AGENT-WRITE',
        'C8-MULTI-FILE-WATCHER',
      ]);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('agent write then file-watcher overwrite — file-watcher content wins reconciliation', async () => {
    const docName = `c8-overwrite-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, '# C8 Overwrite\n\nOriginal.\n', 'utf-8');
    await wait(500);

    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await pollUntil(() => client.ytext.toString().includes('Original'), 5000);
      await wait(500);

      // Agent appends
      await agentWriteMd(server.port, '\n\nC8-AGENT-BEFORE-OVERWRITE\n', {
        docName,
        position: 'append',
      });
      await pollUntil(() => client.ytext.toString().includes('C8-AGENT-BEFORE-OVERWRITE'), 5000);
      await wait(300);

      // File-watcher writes a new version. Since the file watcher triggers
      // reconciliation (three-way merge), the agent content that's already
      // persisted to disk should merge with the new disk content.
      const currentDisk = readTestDoc(server.contentDir, docName);
      writeFileSync(filePath, `${currentDisk}\nC8-FILE-WATCHER-AFTER-AGENT\n`, 'utf-8');

      await pollUntil(() => client.ytext.toString().includes('C8-FILE-WATCHER-AFTER-AGENT'), 8000);
      await wait(500);

      // Bridge invariant should hold
      assertBridgeInvariant(client.ytext, client.fragment);

      // Both contributions should be present
      const text = client.ytext.toString();
      expect(text).toContain('C8-AGENT-BEFORE-OVERWRITE');
      expect(text).toContain('C8-FILE-WATCHER-AFTER-AGENT');
    } finally {
      await client.cleanup();
    }
  });

  test('WYSIWYG edit then file-watcher change — WYSIWYG content preserved through reconciliation', async () => {
    const docName = `c8-wysiwyg-file-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, '# C8 WYSIWYG File\n\nSeed.\n', 'utf-8');
    await wait(500);

    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await pollUntil(() => client.ytext.toString().includes('Seed'), 5000);
      await wait(500);

      // WYSIWYG edit
      appendParagraph(client, 'C8-WYSIWYG-BEFORE-FILE');

      // Wait for WYSIWYG to propagate through server bridge to Y.Text + disk
      await pollUntil(() => client.ytext.toString().includes('C8-WYSIWYG-BEFORE-FILE'), 5000);
      await wait(500);

      // File-watcher change — append to whatever is on disk
      const currentDisk = readTestDoc(server.contentDir, docName);
      writeFileSync(filePath, `${currentDisk}\nC8-FILE-AFTER-WYSIWYG\n`, 'utf-8');

      await pollUntil(() => client.ytext.toString().includes('C8-FILE-AFTER-WYSIWYG'), 8000);
      await wait(500);

      assertBridgeInvariant(client.ytext, client.fragment);

      const text = client.ytext.toString();
      expect(text).toContain('C8-WYSIWYG-BEFORE-FILE');
      expect(text).toContain('C8-FILE-AFTER-WYSIWYG');
    } finally {
      await client.cleanup();
    }
  });
});
