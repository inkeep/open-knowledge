/**
 * Source-mode write-back guard (live Observer-A altitude).
 *
 * A source-mode keystroke on indented MDX-JSX (`<Steps>`), with the
 * hidden-but-mounted WYSIWYG TipTap binding as the single-client trigger, was
 * hypothesized to make Server Observer A write Y.Text back re-indented (cursor
 * jump + byte change + broken undo, all faces of the same write-back). The
 * write-back fires only when `serialize(fragment)` exceeds the bridge tolerance
 * for the shape.
 *
 * Empirical verdict (this guard): the re-indent facet is CLOSED on the current
 * base — `foldJsxContainerBoundaryBlanks` brought the faithful `<Steps>`
 * shapes within `normalizeBridge` tolerance, so Observer A no longer re-indents.
 * These guards drive the LIVE Observer-A path (the md->md fixed-point altitude is
 * blind to it) and read RAW `Y.Text('source')` bytes (every shared comparator
 * trimEnds), so a regression that re-opens the write-back reddens here.
 *
 * The cursor-jump facet is downstream of the same write-back (the y-codemirror
 * remap is Y.Text-delta-driven; no Y.Text change => no caret move), so guarding
 * the bytes guards the caret.
 *
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment } from '@tiptap/y-tiptap';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  getServerState,
  mdManager,
  schema,
  type TestClient,
  type TestServer,
} from './test-harness';

// A faithful, blank-line-delimited <Steps> that parses to a real MDX component
// (OK lifts `mdxJsxFlowElement` -> the `jsxComponent` mdast node). The compact
// no-blank-line form can fall back to a non-MDX parse.
const STEPS = [
  '<Steps>',
  '',
  '<Step>',
  '',
  'Content one.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'Content two.',
  '',
  '</Step>',
  '',
  '</Steps>',
  '',
].join('\n');

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

/** A genuine WYSIWYG-side fragment commit (null origin => server Observer A sees
 *  a real WYSIWYG mutation, xmlDirty=true) — the same channel the hidden-but-
 *  mounted TipTap binding republishes through. Non-vacuous: it really changes
 *  the fragment, so Observer A runs and its serialize-vs-ytext diff is exercised. */
function applyWysiwygEdit(client: TestClient, markdownAfterEdit: string): void {
  const pmNode = schema.nodeFromJSON(mdManager.parse(markdownAfterEdit));
  client.doc.transact(() => {
    updateYFragment(client.doc, client.fragment, pmNode, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
}

const INDENTED_STEP = /\n[ \t]+<\/?Step\b/; // a <Step>/</Step> tag gaining leading indentation
const INDENTED_STEPS = /\n[ \t]+<\/?Steps\b/;

describe('bug #3 — source-mode write-back guard (re-indent facet closed by #1991)', () => {
  test('the faithful <Steps> parses to a jsxComponent and is a serialize fixed point', () => {
    const tree = mdManager.parse(STEPS) as { content?: Array<{ type?: string }> };
    const topTypes = (tree.content ?? []).map((n) => n.type);
    // The md->md proxy for the write-back gating condition: serialize(parse(x)) === x
    // (within tolerance) means Observer A has nothing beyond-tolerance to write back.
    expect(topTypes).toContain('jsxComponent');
    // <Steps> is a serialize fixed point: pin the exact expected output as a literal
    // (a public-contract assertion), not a serialize(parse(x)) === x round-trip oracle.
    expect(mdManager.serialize(mdManager.parse(STEPS))).toBe(
      '<Steps>\n\n<Step>\n\nContent one.\n\n</Step>\n\n<Step>\n\nContent two.\n\n</Step>\n\n</Steps>\n',
    );
  });

  test('V1 baseline: an isolated source keystroke stays byte-verbatim (no Observer-A write-back)', async () => {
    const docName = `bug3-v1-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, STEPS, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      const ytext = client.doc.getText('source');
      await awaitDocQuiescence(client.doc);
      expect(ytext.toString()).toBe(STEPS); // seed landed verbatim
      const at = ytext.toString().indexOf('Content one.') + 'Content one'.length;
      client.doc.transact(() => ytext.insert(at, 'X'));
      const expected = ytext.toString();
      await awaitDocQuiescence(client.doc);
      // RAW server bytes: only the X, no re-indent, nothing shuffled.
      expect(getServerState(server, docName)?.ytext.toString()).toBe(expected);
    } finally {
      await client.cleanup();
    }
  });

  test('a concurrent WYSIWYG fragment commit does NOT re-indent the <Steps> in Y.Text', async () => {
    const docName = `bug3-writeback-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, STEPS, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      const ytext = client.doc.getText('source');
      await awaitDocQuiescence(client.doc);
      expect(ytext.toString()).toBe(STEPS);

      // Genuine WYSIWYG-side change (fires Observer A): edit "Content two." text.
      applyWysiwygEdit(client, STEPS.replace('Content two.', 'Content two, edited.'));
      await awaitDocQuiescence(client.doc);

      const after = getServerState(server, docName)?.ytext.toString() ?? '';
      expect(after).toContain('Content two, edited.'); // the edit landed (non-vacuous)
      // bug #3 re-indent facet: the <Steps>/<Step> tags must NOT gain indentation.
      expect(after).not.toMatch(INDENTED_STEP);
      expect(after).not.toMatch(INDENTED_STEPS);
    } finally {
      await client.cleanup();
    }
  });
});
