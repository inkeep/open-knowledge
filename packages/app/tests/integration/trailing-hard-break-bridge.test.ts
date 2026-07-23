/**
 * Trailing hardBreak through the real server bridge (Observer A/B).
 *
 * A WYSIWYG-created hard break at the end of a paragraph must not surface a
 * stray `\` in Y.Text ("forward slash at end of line" report), and the
 * fragment↔Y.Text pair must converge to the same bytes — the historical
 * failure was a split-brain where deleting the `\` from source left the
 * hardBreak node in the fragment and the next Observer A drain re-emitted it,
 * masked from the watchdog by parse-equivalence tolerance.
 */

import { updateYFragment } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, test } from 'vitest';
import {
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  schema,
  serializeFragment,
  type TestServer,
  wait,
} from './test-harness';

describe('trailing hardBreak bridge convergence', () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.cleanup();
    server = undefined;
  });

  test('WYSIWYG trailing hardBreak: no stray backslash, fragment and Y.Text converge', async () => {
    server = await createTestServer();
    const docName = `trailing-hardbreak-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName);
    try {
      await wait(300);

      const pmDoc = schema.nodeFromJSON({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'hello' }, { type: 'hardBreak' }],
          },
        ],
      });
      client.doc.transact(() => {
        updateYFragment(client.doc, client.fragment, pmDoc, {
          mapping: new Map(),
          isOMark: new Map(),
        });
      });
      await awaitDocQuiescence(client.doc);
      for (let i = 0; i < 60 && client.ytext.toString().length === 0; i++) await wait(100);
      await wait(300);

      const ytext = client.ytext.toString();
      const fragMd = serializeFragment(client.fragment);

      // The stray-character symptom: no backslash may reach source bytes.
      expect(ytext).toBe('hello\n');
      // The split-brain: fragment serialization must equal Y.Text, so a
      // subsequent Observer A drain cannot re-emit a deleted character.
      expect(fragMd).toBe(ytext);

      // A later fragment change must not resurrect a trailing backslash.
      const pmDoc2 = schema.nodeFromJSON({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'hello there' }, { type: 'hardBreak' }],
          },
        ],
      });
      client.doc.transact(() => {
        updateYFragment(client.doc, client.fragment, pmDoc2, {
          mapping: new Map(),
          isOMark: new Map(),
        });
      });
      await awaitDocQuiescence(client.doc);
      await wait(500);
      const ytext2 = client.ytext.toString();
      expect(ytext2).toBe('hello there\n');
      expect(serializeFragment(client.fragment)).toBe(ytext2);
    } finally {
      await client.cleanup();
    }
  }, 30_000);

  test('mid-paragraph hard break still round-trips through the bridge', async () => {
    server = await createTestServer();
    const docName = `midline-hardbreak-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName);
    try {
      await wait(300);
      const pmDoc = schema.nodeFromJSON({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'a' },
              { type: 'hardBreak', attrs: { hardBreakStyle: 'backslash', sourceRaw: null } },
              { type: 'text', text: 'b' },
            ],
          },
        ],
      });
      client.doc.transact(() => {
        updateYFragment(client.doc, client.fragment, pmDoc, {
          mapping: new Map(),
          isOMark: new Map(),
        });
      });
      await awaitDocQuiescence(client.doc);
      for (let i = 0; i < 60 && client.ytext.toString().length === 0; i++) await wait(100);
      await wait(300);

      expect(client.ytext.toString()).toBe('a\\\nb\n');
      expect(serializeFragment(client.fragment)).toBe('a\\\nb\n');
    } finally {
      await client.cleanup();
    }
  }, 30_000);
});
