/**
 * R9 — the named worst-case composition (H15 × H9): a pending WYSIWYG keystroke
 * concurrent with a paired-intake derive while a client reconnects and resyncs.
 * The invariant is no SILENT loss: the keystroke survives (pre-drain, cross-block)
 * or is checkpoint-restorable (same-block/overlap), per R1's routing, and every
 * client converges.
 *
 * The un-propagated keystroke is staged directly on the booted server's doc (a
 * component whose children advance past its stamped source under a
 * freshness-suppressed drain) — the same real stomp shape the paired-intake
 * suite proves. Section 9.5(2): the client-side reconnect here uses the harness
 * sync-control seam, not real browser backgrounding.
 */

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
// The server serializes freshness-ON (its md-manager singleton), so a component's
// advanced children reach the observers; a freshness-OFF manager would read the
// stale stored source. Match it for the staging + fragment reads.
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

/** Leave the fragment holding PENDING_LINE while Y.Text still holds STALE_LINE. */
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

      // Concurrent client typing (a source-mode edit), then a reconnect gap:
      // pauseSync leaves the client behind while the server keeps advancing.
      client.doc.transact(() => {
        client?.ytext.insert(client.ytext.length, '\nClient typed line.\n');
      }, 'client-source');
      // The scenario is "the client is BEHIND after having contributed", so the
      // typing must have reached the server before the pause. A fixed sleep
      // silently turns this into "the client is behind having contributed
      // nothing" whenever it is short, and every assertion below still passes.
      await pollUntil(
        () => getServerState(server, docName)?.md.includes('Client typed line.') ?? false,
        10_000,
      );
      client.pauseSync();

      // A pending WYSIWYG keystroke on the server, cross-block from an append.
      const state = getServerState(server, docName);
      const doc = server.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
      stageUnpropagatedKeystroke(doc, state?.ytext as Y.Text, state?.fragment as Y.XmlFragment);

      // The paired-intake derive: an agent append. Pre-drain flushes the
      // non-overlapping keystroke into Y.Text before the paired transact.
      await agentWriteMd(server.port, 'Agent appended during reconnect.', {
        docName,
        position: 'append',
      });

      // No silent loss on the server: the keystroke survived AND the append landed.
      const after = getServerState(server, docName);
      expect(after?.md).toContain(PENDING_LINE);
      expect(after?.md).toContain('Agent appended during reconnect.');

      // Resync the reconnecting client and confirm convergence — the survived
      // keystroke, the client's earlier typing, and the agent append all reconcile.
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
