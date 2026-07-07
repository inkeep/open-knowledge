/**
 * C13: Path B merge-input doc-boundary alignment — multi-client convergence.
 *
 * The server-side Observer A Path B compose builds its merge userText from
 * `prependFrontmatter(fm, serialize(fragment))`; a live Y.XmlFragment cannot
 * carry the `sourceDocBoundary` doc-node attr, so the user's blank line
 * between the FM close fence and the body is missing from userText while
 * the merge baseline/agentText (raw Y.Text bytes) carry it. The misaligned
 * diff3 fabricates a duplicate of the first body paragraph and silently
 * deletes the user's boundary blank line. Single-client coverage lives in
 * packages/server/src/server-observers.path-b-doc-boundary.test.ts; this
 * test pins the same user-outcome contract across REAL WebSocket peers
 * (remote transactions, local=false), where corruption propagates to every
 * client via the post-merge re-derive.
 *
 * Scenario: client B makes an in-tolerance source-mode edit (trailing space
 * at the end of the first body line — unabsorbed, server Observer B
 * early-exits) and client A then types into the first body paragraph in
 * WYSIWYG. After convergence, BOTH clients must hold both edits verbatim
 * with nothing fabricated: no paragraph duplication, boundary blank line
 * intact.
 *
 * Per-test docName isolation; client lifecycle in try/finally.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  createTestClients,
  createTestServer,
  pollUntil,
  serializeFragment,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const FM = '---\ntitle: Boundary alignment\n---\n';
const RAW = `${FM}\nFirst paragraph body.\n\nSecond paragraph stays.\n`;
const EXPECTED_CONVERGED = `${FM}\nZFirst paragraph body. \n\nSecond paragraph stays.\n`;

function findTextNodeContaining(
  node: Y.XmlFragment | Y.XmlElement,
  needle: string,
): Y.XmlText | null {
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlText && child.toString().includes(needle)) return child;
    if (child instanceof Y.XmlElement) {
      const found = findTextNodeContaining(child, needle);
      if (found) return found;
    }
  }
  return null;
}

describe('C13: Path B doc-boundary alignment across clients', () => {
  test('concurrent source + WYSIWYG edits on an FM doc — no duplication, boundary blank line survives on every client', async () => {
    const docName = `c13-boundary-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      // Seed the universal FM authoring shape (blank line between the close
      // fence and the body) verbatim via the W3 replace surface.
      await agentWriteMd(server.port, RAW, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === RAW), 5000);
      // Let the server observer drain fully settle before the client edits.
      await wait(500);

      // Client B: source-mode keystroke — trailing space at the end of the
      // first body line. Within normalizeBridge tolerance, so the server
      // bridge leaves it unabsorbed (Y.Text diverges from the raw witness).
      const b = clients[1];
      b.doc.transact(() => {
        b.ytext.insert(
          b.ytext.toString().indexOf('First paragraph body.') + 'First paragraph body.'.length,
          ' ',
        );
      });
      await pollUntil(
        () => clients.every((c) => c.ytext.toString().includes('First paragraph body. \n')),
        5000,
      );
      await wait(300);

      // Client A: WYSIWYG keystroke into the first body paragraph — the
      // next settlement drain routes the server's Path B merge.
      const a = clients[0];
      a.doc.transact(() => {
        const textNode = findTextNodeContaining(a.fragment, 'First paragraph');
        if (!textNode) throw new Error('no fragment text node containing "First paragraph"');
        textNode.insert(0, 'Z');
      });
      await pollUntil(() => clients.every((c) => c.ytext.toString().includes('ZFirst')), 5000);
      // Let the post-merge settlement + WebSocket propagation finish.
      await wait(500);
      // Wait for each client's WYSIWYG fragment to re-derive from the merged
      // Y.Text (the server is the sole fragment writer; updates arrive over
      // WebSocket). Event-driven so the fragment check below does not race the
      // re-derive.
      await pollUntil(
        () => clients.every((c) => serializeFragment(c.fragment).includes('ZFirst paragraph body')),
        5000,
      );

      for (const c of clients) {
        const text = c.ytext.toString();
        // No fabrication: the first body paragraph appears exactly once.
        const para1Count = text.split('First paragraph body').length - 1;
        expect(para1Count).toBe(1);
        // The user's doc-boundary blank line survives (storage never
        // sanitizes — it is user bytes in the body region of Y.Text).
        expect(text).toContain('---\n\n');
        // Both edits land verbatim on the one surviving line.
        expect(text).toContain('ZFirst paragraph body. \n');
        // Full byte-exact settlement, per the aligned-input oracle
        // (boundary-aligned merge inputs land both edits with no
        // fabrication).
        expect(text).toBe(EXPECTED_CONVERGED);

        // The WYSIWYG fragment (what the user sees) re-derives from the merged
        // Y.Text; assert the fabrication is absent there too. The automated
        // Y.Text<->fragment watcher is disabled for this test
        // (skipInvariantWatcher), so this is the explicit check that the
        // re-derived fragment did not duplicate the first body paragraph.
        const fragMd = serializeFragment(c.fragment);
        expect(fragMd.split('First paragraph body').length - 1).toBe(1);
        expect(fragMd).toContain('ZFirst paragraph body');
      }
      // Peers converged to identical bytes.
      expect(clients[0].ytext.toString()).toBe(clients[1].ytext.toString());
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
