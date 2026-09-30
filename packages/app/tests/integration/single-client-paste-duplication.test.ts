import type { Node as PmNode } from '@tiptap/pm/model';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  appendProjectionParagraph,
  applyProjectionEdit,
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  getServerState,
  type TestClient,
  type TestServer,
} from './test-harness';

const PARA = 'This is a pasted body paragraph.';

let server: TestServer;
let client: TestClient;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await client?.cleanup();
  await server?.cleanup();
});

test('a single client duplicating a paragraph forward-propagates both copies into Y.Text', async () => {
  client = await createTestClient(server.port, undefined);

  appendProjectionParagraph(client, PARA);
  await awaitDocQuiescence(client.doc, { timeoutMs: 10_000, idleTicks: 5 });

  const mid = getServerState(server, client.docName);
  expect(mid?.ytext.toString().match(/This is a pasted body paragraph\./g)?.length).toBe(1);

  appendProjectionParagraph(client, PARA);
  await awaitDocQuiescence(client.doc, { timeoutMs: 15_000, idleTicks: 10 });

  const post = getServerState(server, client.docName);
  expect(post).not.toBeNull();
  const bytes = post?.ytext.toString() ?? '';
  expect(bytes.match(/This is a pasted body paragraph\./g)?.length ?? 0).toBe(2);
}, 30_000);

test('pasting a duplicate of a component block forward-propagates (shape agrees)', async () => {
  const client3 = await createTestClient(server.port, undefined);
  const steps = '<Steps>\n\n<Step>\n\nCloned step body content.\n\n</Step>\n\n</Steps>\n';
  try {
    client3.doc.transact(() => client3.ytext.insert(0, steps));
    await awaitDocQuiescence(client3.doc, { timeoutMs: 10_000, idleTicks: 5 });

    const seeded = getServerState(server, client3.docName);
    expect(seeded?.ytext.toString().match(/Cloned step body content\./g)?.length).toBe(1);

    applyProjectionEdit(client3, (tr, doc) => {
      let component: PmNode | null = null;
      doc.forEach((child) => {
        if (component === null && child.type.name === 'jsxComponent') component = child;
      });
      if (component === null) throw new Error('no jsxComponent block in the projection');
      return tr.insert(doc.content.size, component);
    });
    await awaitDocQuiescence(client3.doc, { timeoutMs: 15_000, idleTicks: 10 });

    const post = getServerState(server, client3.docName);
    const bytes = post?.ytext.toString() ?? '';
    expect(bytes.match(/Cloned step body content\./g)?.length ?? 0).toBe(2);
    expect(bytes.match(/<Steps>/g)?.length ?? 0).toBe(2);
  } finally {
    await client3.cleanup();
  }
}, 30_000);

test('pasting a duplicate of source-authored content still forward-propagates', async () => {
  const client2 = await createTestClient(server.port, undefined);
  const marker = 'This is a source-authored body paragraph.';
  try {
    client2.doc.transact(() => client2.ytext.insert(0, `${marker}\n`));
    await awaitDocQuiescence(client2.doc, { timeoutMs: 10_000, idleTicks: 5 });

    const seeded = getServerState(server, client2.docName);
    expect(seeded?.ytext.toString().match(/source-authored body paragraph/g)?.length).toBe(1);

    appendProjectionParagraph(client2, marker);
    await awaitDocQuiescence(client2.doc, { timeoutMs: 15_000, idleTicks: 10 });

    const post = getServerState(server, client2.docName);
    const n = post?.ytext.toString().match(/source-authored body paragraph/g)?.length ?? 0;
    expect(n).toBe(2);
  } finally {
    await client2.cleanup();
  }
}, 30_000);
