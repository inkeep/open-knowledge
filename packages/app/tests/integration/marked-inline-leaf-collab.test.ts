/**
 * Multi-client (two-peer) coverage for emphasis marks on inline leaf nodes.
 *
 * The Yjs-bridge fix stores an inline leaf's marks as reserved Y attributes, so
 * they should ride normal CRDT attribute sync to a second peer and survive that
 * peer's subsequent, unrelated edits. The storage-round-trip fidelity tests are
 * single-Y.Doc; OK's rule is that conversion/observer changes require multi-client
 * (C1-C10) coverage because single-client tests miss remote-peer WYSIWYG
 * divergence. This drives a real two-peer Hocuspocus sync with the
 * bridge-invariant watcher attached on both peers (default) — a dropped mark
 * diverges `serialize(fragment)` from `ytext` and throws during drain, so the
 * test fails on a regression even before the explicit mark assertions.
 */

import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  assertAllConverged,
  createTestClients,
  createTestServer,
  mdManager,
  pollUntil,
  schema,
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

/** Simulate a WYSIWYG edit: parse markdown -> PM node -> updateYFragment, in one Y transaction (the shape ySyncPlugin uses on every editor transaction). */
function applyMarkdownToFragment(client: TestClient, md: string): void {
  const pmNode = schema.nodeFromJSON(mdManager.parse(md));
  const meta = { mapping: new Map(), isOMark: new Map() };
  client.doc.transact(() => {
    updateYFragment(client.doc, client.fragment, pmNode, meta);
  });
}

/** An unrelated edit on a peer: append a plain paragraph via raw Y ops (leaves the wikiLink untouched). */
function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

/** Whether the first inline leaf of the given type in the client's derived PM doc carries the strong mark. */
function leafHasStrong(client: TestClient, typeName: string): boolean {
  const root = yXmlFragmentToProseMirrorRootNode(client.fragment, schema);
  let has = false;
  root.descendants((node) => {
    if (!has && node.type.name === typeName) {
      has = node.marks.some((m) => m.type.name === 'strong');
    }
    return !has;
  });
  return has;
}

describe('marked inline leaf nodes through multi-client collaboration', () => {
  test('a strong-marked wikilink syncs to a second peer and survives its edit', async () => {
    const docName = `marked-leaf-collab-${crypto.randomUUID()}`;
    const [clientA, clientB] = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: false },
    });

    try {
      // Peer A authors **[[a]]** via a WYSIWYG-shaped edit.
      applyMarkdownToFragment(clientA, '**[[a]]**\n');

      // It converges to peer B carrying the strong mark (the reserved ymark:
      // attribute rides normal CRDT attribute sync).
      await pollUntil(() => clientB.ytext.toString().includes('[[a]]'), 8000);
      await assertAllConverged([clientA, clientB], { timeout: 8000 });
      expect(serializeFragment(clientB.fragment)).toContain('**[[a]]**');
      expect(leafHasStrong(clientB, 'wikiLink')).toBe(true);

      // Peer B makes an unrelated edit; A's marked wikilink must survive on both.
      appendParagraph(clientB, 'edited by B');
      await pollUntil(() => clientA.ytext.toString().includes('edited by B'), 8000);
      await assertAllConverged([clientA, clientB], { timeout: 8000 });
      expect(serializeFragment(clientA.fragment)).toContain('**[[a]]**');
      expect(serializeFragment(clientB.fragment)).toContain('**[[a]]**');
      expect(leafHasStrong(clientA, 'wikiLink')).toBe(true);
      expect(leafHasStrong(clientB, 'wikiLink')).toBe(true);
    } finally {
      await clientA.cleanup();
      await clientB.cleanup();
    }
  });

  // The bridge stores marks as type-agnostic reserved Y attributes, so the
  // sync-to-peer property holds for every inline leaf, not just wikiLink. Each
  // case authors `**<leaf>**` on peer A and asserts the strong mark reaches B.
  const LEAF_CASES: Array<{ name: string; md: string; type: string; needle: string }> = [
    { name: 'image', md: '**![alt](file.png)**\n', type: 'image', needle: '![alt](file.png)' },
    { name: 'tag', md: '**#mytag**\n', type: 'tag', needle: '#mytag' },
    { name: 'inline math', md: '**$x = 1$**\n', type: 'mathInline', needle: '$x = 1$' },
  ];
  for (const c of LEAF_CASES) {
    test(`a strong-marked ${c.name} syncs to a second peer`, async () => {
      const docName = `marked-leaf-collab-${c.type}-${crypto.randomUUID()}`;
      const [clientA, clientB] = await createTestClients(server.port, {
        count: 2,
        docName,
        perClientOptions: { skipInvariantWatcher: false },
      });
      try {
        applyMarkdownToFragment(clientA, c.md);
        await pollUntil(() => clientB.ytext.toString().includes(c.needle), 8000);
        await assertAllConverged([clientA, clientB], { timeout: 8000 });
        expect(serializeFragment(clientB.fragment)).toContain(c.md.trim());
        expect(leafHasStrong(clientB, c.type)).toBe(true);
      } finally {
        await clientA.cleanup();
        await clientB.cleanup();
      }
    });
  }
});
