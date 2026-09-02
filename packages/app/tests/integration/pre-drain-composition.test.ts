import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import {
  agentWriteMd,
  assertAllConverged,
  createTestClient,
  createTestServer,
  getServerState,
  HARNESS_BOOT_TIMEOUT_MS,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

const schema = getSchema(sharedExtensions);
const mdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});

const GEN1 =
  '## Guide\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n\nTail paragraph.\n';
const STALE_LINE = 'Step one bod';
const PENDING_LINE = 'Step one body.';

function serializeFragment(fragment: Y.XmlFragment): string {
  return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
}

function mutateFirstText(node: JSONContent, from: string, to: string): boolean {
  if (typeof node.text === 'string' && node.text === from) {
    node.text = to;
    return true;
  }
  for (const child of node.content ?? []) {
    if (mutateFirstText(child, from, to)) return true;
  }
  return false;
}

function stageUnpropagatedKeystroke(doc: Y.Doc, ytext: Y.Text, fragment: Y.XmlFragment): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_000);
  doc.transact(() => {
    ytext.insert(ytext.length, '\nTrailing.\n');
  }, 'external-peer');
  const echo = mdManager.parse(ytext.toString()) as JSONContent;
  expect(mutateFirstText(echo, STALE_LINE, PENDING_LINE)).toBe(true);
  doc.transact(() => {
    updateYFragment(doc, fragment, schema.nodeFromJSON(echo), {
      mapping: new Map(),
      isOMark: new Map(),
    });
  }, 'wysiwyg-echo');
  expect(serializeFragment(fragment)).toContain(PENDING_LINE);
  expect(ytext.toString()).not.toContain(PENDING_LINE);
  vi.useRealTimers();
}

describe('R9 pre-drain composition (H15 × H9)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer({ gitEnabled: true, debounce: 300_000, maxDebounce: 600_000 });
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterEach(async () => {
    vi.useRealTimers();
    await server.cleanup();
  });

  test('cross-block keystroke survives a paired derive while a client reconnects and resyncs', async () => {
    const docName = `r9-${crypto.randomUUID().slice(0, 8)}`;
    await agentWriteMd(server.port, GEN1, { docName, position: 'replace' });

    let client: TestClient | undefined;
    try {
      client = await createTestClient(server.port, docName, { syncControl: true });

      client.doc.transact(() => {
        client?.ytext.insert(client.ytext.length, '\nClient typed line.\n');
      }, 'client-source');
      await pollUntil(
        () => getServerState(server, docName)?.md.includes('Client typed line.') ?? false,
        10_000,
      );
      client.pauseSync();

      const state = getServerState(server, docName);
      const doc = server.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
      stageUnpropagatedKeystroke(doc, state?.ytext as Y.Text, state?.fragment as Y.XmlFragment);

      await agentWriteMd(server.port, 'Agent appended during reconnect.', {
        docName,
        position: 'append',
      });

      const after = getServerState(server, docName);
      expect(after?.md).toContain(PENDING_LINE);
      expect(after?.md).toContain('Agent appended during reconnect.');

      client.resumeSync();
      await assertAllConverged([client], { timeout: 10_000 });
      expect(client.ytext.toString()).toContain(PENDING_LINE);
      expect(client.ytext.toString()).toContain('Agent appended during reconnect.');
      expect(client.ytext.toString()).toContain('Client typed line.');
    } finally {
      await client?.cleanup();
    }
  });
});
