/**
 * Regression gate for bridge convergence under concurrent writes.
 *
 * 4 tests — all must pass:
 *
 *   P0: human WYSIWYG typing + agent MCP write on same line
 *   P0-stress: rapid interleaved user + agent writes
 *   P1: human WYSIWYG typing + file-watcher disk update (unaffected path)
 *   CONTROL: peer+peer XmlFragment edits
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment } from '@tiptap/y-tiptap';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertBridgeInvariant,
  createTestClient,
  createTestServer,
  mdManager,
  pollUntil,
  schema,
  type TestClient,
  type TestServer,
  testReset,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

/** Apply markdown to client XmlFragment via updateYFragment — simulates a user local edit. */
function applyMarkdownToFragment(client: TestClient, md: string): void {
  const parsed = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(parsed);
  client.doc.transact(() => {
    const meta = { mapping: new Map(), isOMark: new Map() };
    updateYFragment(client.doc, client.fragment, pmNode, meta);
  });
}

describe('Bridge convergence regression', () => {
  test('P0: user XmlFragment edit + agent write — both preserved (Bug-A fix)', async () => {
    const docName = `test-p0-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName);

    try {
      // User makes a local XmlFragment edit (schedules Observer A debounce).
      applyMarkdownToFragment(client, 'user line one edited by user\n');

      // Agent writes before debounce fires — server composes via
      // applyAgentMarkdownWrite (XmlFragment-authoritative).
      await agentWriteMd(server.port, 'agent line X\n', {
        docName,
        position: 'append',
      });

      // Settle.
      await wait(800);

      const finalYtext = client.ytext.toString();
      expect(finalYtext).toContain('edited by user');
      expect(finalYtext).toContain('agent line X');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('P0-stress: rapid interleaved user + agent writes — bridge invariant holds (Bug-A stress)', async () => {
    const docName = `test-p0-stress-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName);

    try {
      const rounds = 10;
      for (let i = 0; i < rounds; i++) {
        // User replaces XmlFragment content (simulates typing over previous content).
        applyMarkdownToFragment(client, `round ${i}: user text ${i}\n`);
        // Agent appends immediately after.
        await agentWriteMd(server.port, `round ${i}: agent-${i}\n`, {
          docName,
          position: 'append',
        });
      }

      await wait(1200);

      const finalYtext = client.ytext.toString();

      // The latest agent write must be present (agent writes are cumulative appends).
      expect(finalYtext).toContain('agent-9');

      // The latest user text must be present (XmlFragment-authoritative preserves
      // the user's XmlFragment state at the time of each agent write).
      expect(finalYtext).toContain('user text 9');

      // Bridge invariant must hold.
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('P1: user XmlFragment edit + file-watcher disk update — bridge invariant holds', async () => {
    await testReset(server.port);
    await wait(200);
    const client = await createTestClient(server.port, 'test-doc');

    try {
      // User types locally.
      applyMarkdownToFragment(client, 'user typed this\n');

      // File watcher overwrites from disk.
      const filePath = join(server.contentDir, 'test-doc.md');
      writeFileSync(filePath, 'file-watcher overwrote this\n', 'utf-8');

      // Wait for fs watcher + propagation + Observer A debounce.
      await wait(2000);

      // Bridge invariant: Y.Text and XmlFragment must be in sync.
      // The file-watcher path (applyExternalChange) is unaffected by this spec's
      // changes — it was already correct (P1 reproducer confirms).
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('CONTROL: peer+peer XmlFragment edits — XmlFragments converge, agent write reconciles Y.Text', async () => {
    // Two peer WYSIWYG clients typing concurrently. This tests:
    // 1. Both XmlFragments converge via CRDT tree sync (always works).
    // 2. A subsequent agent write reconciles Y.Text via applyAgentMarkdownWrite
    //    (the XmlFragment-authoritative pattern restores bridge invariant).
    const docName = `test-ctrl-${crypto.randomUUID()}`;
    const clientA = await createTestClient(server.port, docName);
    const clientB = await createTestClient(server.port, docName);

    try {
      // Seed via agent write.
      await agentWriteMd(server.port, 'shared baseline\n', {
        docName,
        position: 'replace',
      });
      await pollUntil(
        () =>
          clientA.ytext.toString().includes('shared baseline') &&
          clientB.ytext.toString().includes('shared baseline'),
        5000,
      );

      // Both clients edit their local XmlFragment concurrently.
      applyMarkdownToFragment(clientA, 'shared baseline AAA from A\n');
      applyMarkdownToFragment(clientB, 'shared baseline BBB from B\n');

      // Settle CRDT propagation for XmlFragments.
      await wait(1000);

      // Both XmlFragments must converge (CRDT tree sync).
      const { yXmlFragmentToProseMirrorRootNode: toRootNode } = await import('@tiptap/y-tiptap');
      const aMd = mdManager.serialize(toRootNode(clientA.fragment, schema).toJSON());
      const bMd = mdManager.serialize(toRootNode(clientB.fragment, schema).toJSON());
      expect(aMd).toContain('AAA from A');
      expect(aMd).toContain('BBB from B');
      expect(bMd).toContain('AAA from A');
      expect(bMd).toContain('BBB from B');

      // Agent write reconciles Y.Text to match XmlFragment via the
      // XmlFragment-authoritative pattern (applyAgentMarkdownWrite).
      await agentWriteMd(server.port, 'reconcile marker\n', { docName, position: 'append' });
      await wait(800);

      // Bridge invariant should hold on both clients after agent-write
      // reconciliation.
      assertBridgeInvariant(clientA.ytext, clientA.fragment);
      assertBridgeInvariant(clientB.ytext, clientB.fragment);
    } finally {
      await clientA.cleanup();
      await clientB.cleanup();
    }
  });
});
