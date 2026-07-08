/**
 * Interior-edit freshness through the real Observer-A drain.
 *
 * A registered PM-editable component (Callout) serializes via its pristine
 * `sourceRaw` byte cache while `sourceDirty` is false; an interior edit inside
 * its NodeViewContent flips `sourceDirty` so the serializer IGNORES the now-stale
 * `sourceRaw` and re-derives from the edited children. This drives that wire
 * state (interior text mutated + the enclosing Callout's `sourceDirty` flipped,
 * `sourceRaw` deliberately left stale) through a REAL Hocuspocus server and reads
 * the persisted `Y.Text('source')` bytes at the Observer-A altitude — the same
 * bytes a reopen or a teammate receives.
 *
 * The freshness is non-vacuous by construction: `sourceRaw` still holds the
 * pre-edit source, so bytes carrying the edit can only have come from
 * re-derivation. The second case drops the client flip entirely: the
 * server-side structural-freshness derivation detects that the children no
 * longer match the stale `sourceRaw` and re-derives anyway — the producer-side
 * backstop for the exact stale-bytes corruption a deny-listed (non-user)
 * transform would otherwise emit, regardless of whether the client flip fired.
 *
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  getServerState,
  schema,
  type TestClient,
  type TestServer,
} from './test-harness';

// A registered Callout whose interior is a real paragraph (the NodeViewContent
// hole an author types into). Blank-line delimited so it lifts to a jsxComponent.
const SEED = ['<Callout type="info">', '', 'Original interior body.', '', '</Callout>', ''].join(
  '\n',
);

type PmNodeJson = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PmNodeJson[];
  marks?: unknown[];
};

/** The doc tree currently in a client's XmlFragment (synced from the server). */
function currentTree(client: TestClient): PmNodeJson {
  return yXmlFragmentToProseMirrorRootNode(client.fragment, schema).toJSON() as PmNodeJson;
}

/**
 * Reproduce a WYSIWYG interior edit as its settled wire state: rewrite the
 * interior text, and (when `flipDirty`) mark the enclosing Callout dirty exactly
 * as the client SourceDirtyObserver would. `sourceRaw` is never touched, so a
 * dirty Callout carries a genuinely stale byte cache.
 */
function planInteriorEdit(
  tree: PmNodeJson,
  find: string,
  replace: string,
  flipDirty: boolean,
): PmNodeJson {
  const next = structuredClone(tree);
  const walk = (node: PmNodeJson): void => {
    if (flipDirty && node.type === 'jsxComponent' && node.attrs?.componentName === 'Callout') {
      node.attrs = { ...node.attrs, sourceDirty: true };
    }
    if (typeof node.text === 'string' && node.text.includes(find)) {
      node.text = node.text.replace(find, replace);
    }
    node.content?.forEach(walk);
  };
  walk(next);
  return next;
}

/** Commit a target doc tree into the client fragment with null origin — the same
 *  channel a local WYSIWYG mutation publishes through (Observer A sees a real
 *  fragment change, xmlDirty=true). */
function commitFragment(client: TestClient, tree: PmNodeJson): void {
  const pmNode = schema.nodeFromJSON(tree);
  client.doc.transact(() => {
    updateYFragment(client.doc, client.fragment, pmNode, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
}

const INDENTED_CALLOUT = /\n[ \t]+<\/?Callout\b/; // a <Callout>/</Callout> tag gaining leading indent

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('interior-edit freshness — Observer-A drain re-derives a dirty registered component', () => {
  test('an interior edit reaches the persisted Y.Text bytes via re-derivation', async () => {
    const docName = `interior-edit-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, SEED, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      await awaitDocQuiescence(client.doc);
      const seeded = client.doc.getText('source').toString();
      // Non-vacuity floor: the edit marker is genuinely absent before the edit.
      expect(seeded).toContain('Original interior body');
      expect(seeded).not.toContain('EDITED');

      commitFragment(client, planInteriorEdit(currentTree(client), 'Original', 'EDITED', true));
      await awaitDocQuiescence(client.doc);

      const after = getServerState(server, docName)?.ytext.toString() ?? '';
      // The edit reached the persisted bytes a reopen or teammate receives.
      expect(after).toContain('EDITED interior body');
      // No re-indent, no growth, no duplication of the container tags.
      expect(after).not.toMatch(INDENTED_CALLOUT);
      expect(after).not.toMatch(/^[ \t]+<Callout\b/m);
      expect(after.match(/<Callout\b/g)).toHaveLength(1);
      expect(after.match(/<\/Callout>/g)).toHaveLength(1);
      // The registered component's props survived the re-derivation.
      expect(after).toContain('type="info"');
    } finally {
      await client.cleanup();
    }
  });

  test('without the client flip, the server structural-freshness derivation re-derives fresh bytes', async () => {
    const docName = `interior-edit-noflip-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, SEED, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      await awaitDocQuiescence(client.doc);
      expect(client.doc.getText('source').toString()).toContain('Original interior body');

      // The children move but the Callout is left flagged pristine (sourceDirty
      // stays false) — the deny-listed-origin divergence the client flip misses.
      commitFragment(client, planInteriorEdit(currentTree(client), 'Original', 'EDITED', false));
      await awaitDocQuiescence(client.doc);

      const after = getServerState(server, docName)?.ytext.toString() ?? '';
      // The server derivation caught children ≠ parse(sourceRaw) and re-derived,
      // so the fresh bytes reach persistence even with no client flip — the
      // stale-bytes class is structurally eliminated, not merely detected.
      expect(after).toContain('EDITED interior body');
      expect(after).not.toContain('Original interior body');
      // Still fresh through re-derivation, not a mangled container.
      expect(after).not.toMatch(INDENTED_CALLOUT);
      expect(after.match(/<Callout\b/g)).toHaveLength(1);
      expect(after).toContain('type="info"');
    } finally {
      await client.cleanup();
    }
  });
});
