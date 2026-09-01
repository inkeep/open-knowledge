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

function applyMarkdownToFragment(client: TestClient, md: string): void {
  const pmNode = schema.nodeFromJSON(mdManager.parse(md));
  const meta = { mapping: new Map(), isOMark: new Map() };
  client.doc.transact(() => {
    updateYFragment(client.doc, client.fragment, pmNode, meta);
  });
}

function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

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
      applyMarkdownToFragment(clientA, '**[[a]]**\n');

      await pollUntil(() => clientB.ytext.toString().includes('[[a]]'), 8000);
      await assertAllConverged([clientA, clientB], { timeout: 8000 });
      expect(serializeFragment(clientB.fragment)).toContain('**[[a]]**');
      expect(leafHasStrong(clientB, 'wikiLink')).toBe(true);

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
