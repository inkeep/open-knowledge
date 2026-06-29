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
    expect(topTypes).toContain('jsxComponent');
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

      applyWysiwygEdit(client, STEPS.replace('Content two.', 'Content two, edited.'));
      await awaitDocQuiescence(client.doc);

      const after = getServerState(server, docName)?.ytext.toString() ?? '';
      expect(after).toContain('Content two, edited.'); // the edit landed (non-vacuous)
      expect(after).not.toMatch(INDENTED_STEP);
      expect(after).not.toMatch(INDENTED_STEPS);
    } finally {
      await client.cleanup();
    }
  });
});
