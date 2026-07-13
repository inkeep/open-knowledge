/**
 * The Observer-A duplication gate must recover a server-vs-client CRDT race but
 * NEVER touch a legitimate same-client duplication: recovery re-derives the
 * fragment from Y.Text, so a false positive would silently drop the user's
 * paste. Provenance is the discriminator — a legitimate duplication is minted
 * entirely by the one editing client (no copy carries the server's own
 * clientID), so the gate's server-plus-foreign signature does not match and the
 * router forward-propagates the second copy into Y.Text.
 *
 * Emulated at the raw Y.js level (a single client inserting two content-equal
 * paragraphs into the fragment) to pin the server/bridge contract independent
 * of any editor surface.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  getServerState,
  type TestClient,
  type TestServer,
} from './test-harness';

const PARA = 'This is a pasted body paragraph.';

function paragraph(text: string): Y.XmlElement {
  const el = new Y.XmlElement('paragraph');
  el.insert(0, [new Y.XmlText(text)]);
  return el;
}

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
  client = await createTestClient(server.port, undefined, { skipInvariantWatcher: true });

  // Author one paragraph in WYSIWYG (client-minted in the fragment), let it
  // settle through to Y.Text.
  client.doc.transact(() => {
    client.fragment.insert(client.fragment.length, [paragraph(PARA)]);
  });
  await awaitDocQuiescence(client.doc, { timeoutMs: 10_000, idleTicks: 5 });

  const mid = getServerState(server, client.docName);
  expect(mid?.ytext.toString().match(/This is a pasted body paragraph\./g)?.length).toBe(1);

  // Paste a second copy — same client, so both carriers share one (foreign to
  // the server) clientID. The fragment now holds the line twice while Y.Text
  // still holds it once, so the growth pre-filter fires; the provenance walk
  // must classify it as a legitimate duplication (no server-minted copy) and
  // let Observer A forward-propagate it.
  client.doc.transact(() => {
    client.fragment.insert(client.fragment.length, [paragraph(PARA)]);
  });
  await awaitDocQuiescence(client.doc, { timeoutMs: 15_000, idleTicks: 10 });

  const post = getServerState(server, client.docName);
  expect(post).not.toBeNull();
  const bytes = post?.ytext.toString() ?? '';
  // The paste survives into authoritative Y.Text — the gate did not fire.
  expect(bytes.match(/This is a pasted body paragraph\./g)?.length ?? 0).toBe(2);
}, 30_000);

test('pasting a duplicate of a SERVER-DERIVED component block forward-propagates (shape agrees)', async () => {
  // Component-shaped variant of the shape-agreement guard: the server derives
  // a jsxComponent under its own clientID; the client then inserts a clone of
  // that element (foreign clientID, SAME node shape). The provenance split
  // matches the race signature but the shapes agree, so the gate must let the
  // router forward-propagate the duplicate block.
  const client3 = await createTestClient(server.port, undefined, { skipInvariantWatcher: true });
  const steps = '<Steps>\n\n<Step>\n\nCloned step body content.\n\n</Step>\n\n</Steps>\n';
  try {
    client3.doc.transact(() => client3.ytext.insert(0, steps));
    await awaitDocQuiescence(client3.doc, { timeoutMs: 10_000, idleTicks: 5 });

    const seeded = getServerState(server, client3.docName);
    expect(seeded?.ytext.toString().match(/Cloned step body content\./g)?.length).toBe(1);

    const component = client3.fragment
      .toArray()
      .find((child) => child instanceof Y.XmlElement && child.nodeName === 'jsxComponent');
    expect(component).toBeInstanceOf(Y.XmlElement);
    client3.doc.transact(() => {
      client3.fragment.insert(client3.fragment.length, [(component as Y.XmlElement).clone()]);
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

test('pasting a duplicate of SERVER-DERIVED content still forward-propagates (shape agrees)', async () => {
  // The harder false-positive: the original was authored in source mode, so
  // Observer B derived the fragment copy under the SERVER clientID. Pasting a
  // duplicate then yields a server-minted + a foreign-minted carrier of the
  // SAME node shape. The provenance split alone would misfire and drop the
  // paste; the shape-agreement guard keeps it (a real race is a shape
  // disagreement, not agreement).
  const client2 = await createTestClient(server.port, undefined, { skipInvariantWatcher: true });
  const marker = 'This is a source-authored body paragraph.';
  try {
    client2.doc.transact(() => client2.ytext.insert(0, `${marker}\n`));
    await awaitDocQuiescence(client2.doc, { timeoutMs: 10_000, idleTicks: 5 });

    const seeded = getServerState(server, client2.docName);
    expect(seeded?.ytext.toString().match(/source-authored body paragraph/g)?.length).toBe(1);

    client2.doc.transact(() => {
      const el = new Y.XmlElement('paragraph');
      el.insert(0, [new Y.XmlText(marker)]);
      client2.fragment.insert(client2.fragment.length, [el]);
    });
    await awaitDocQuiescence(client2.doc, { timeoutMs: 15_000, idleTicks: 10 });

    const post = getServerState(server, client2.docName);
    const n = post?.ytext.toString().match(/source-authored body paragraph/g)?.length ?? 0;
    expect(n).toBe(2);
  } finally {
    await client2.cleanup();
  }
}, 30_000);
