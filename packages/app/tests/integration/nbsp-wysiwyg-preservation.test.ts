/**
 * Document NBSP (U+00A0) preservation through a WYSIWYG edit.
 *
 * Agent writes land raw bytes into Y.Text verbatim (byte-sacred), so a document
 * NBSP is intact at rest. A WYSIWYG edit re-serializes the edited block through
 * the projection splice, so the NBSP must survive the full mdast<->PM
 * round-trip, not just the write. Per precedent #57, an agent-authored byte the
 * human never touched must survive that splice — covered for a SAME-block and a
 * DIFFERENT-block edit; the no-edit control pins the byte-sacred write path.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  applyProjectionEdit,
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  pollUntil,
  projectionPosAfter,
  type TestClient,
  type TestServer,
} from './test-harness';

const NBSP = '\u00A0';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

async function seedThenMaybeEdit(opts: { body: string; editMarker?: string }): Promise<string> {
  const docName = `nbsp-${crypto.randomUUID()}`;
  const client: TestClient = await createTestClient(server.port, docName);
  try {
    await agentWriteMd(server.port, opts.body, { docName, position: 'replace' });
    await pollUntil(() => client.ytext.toString().includes('bar'), 5000);
    await awaitDocQuiescence(client.doc);
    expect(client.ytext.toString()).toContain(NBSP);

    if (opts.editMarker !== undefined) {
      const marker = opts.editMarker;
      applyProjectionEdit(client, (tr, doc) =>
        tr.insertText(' EDITWORD', projectionPosAfter(doc, marker)),
      );
      await pollUntil(() => client.ytext.toString().includes('EDITWORD'), 5000);
      await awaitDocQuiescence(client.doc);
      expect(client.ytext.toString()).toContain('EDITWORD');
    }

    return client.ytext.toString();
  } finally {
    await client.cleanup();
  }
}

describe('document NBSP survives a WYSIWYG edit', () => {
  test('document NBSP survives a WYSIWYG edit in the SAME block', async () => {
    const ytext = await seedThenMaybeEdit({
      body: `Alpha foo${NBSP}bar keepme\n`,
      editMarker: 'keepme',
    });
    expect(ytext).toContain(NBSP);
  }, 25_000);

  test('document NBSP survives a WYSIWYG edit in a DIFFERENT block', async () => {
    const ytext = await seedThenMaybeEdit({
      body: `Kept foo${NBSP}bar paragraph.\n\nEditable paragraph editme.\n`,
      editMarker: 'editme',
    });
    expect(ytext).toContain(NBSP);
  }, 25_000);

  test('document NBSP survives verbatim with no WYSIWYG edit (byte-sacred control)', async () => {
    const ytext = await seedThenMaybeEdit({
      body: `Alpha foo${NBSP}bar keepme\n`,
    });
    expect(ytext).toContain(NBSP);
  }, 25_000);
});
