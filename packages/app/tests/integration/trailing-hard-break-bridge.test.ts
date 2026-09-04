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

  test('WYSIWYG trailing hardBreak: no stray backslash, survives, fragment and Y.Text converge', async () => {
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

      expect(ytext).not.toContain('\\');
      expect(ytext).toBe('hello<br />\n');
      expect(fragMd).toBe(ytext);

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
      expect(ytext2).not.toContain('\\');
      expect(ytext2).toBe('hello there<br />\n');
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
