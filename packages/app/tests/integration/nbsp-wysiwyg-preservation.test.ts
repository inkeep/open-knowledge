/**
 * Document NBSP (U+00A0) preservation through a WYSIWYG edit.
 *
 * Agent writes land raw bytes into Y.Text verbatim (byte-sacred), so a document
 * NBSP is intact at rest. The XmlFragment is a re-parse of the body, and a WYSIWYG
 * edit triggers a server Observer A settlement that re-serializes the fragment
 * over the Y.Text region — so the NBSP must survive the full mdast<->PM
 * round-trip, not just the write. Per precedent #57, an agent-authored byte the
 * human never touched must survive that settlement. Observer A fires on any
 * fragment change, so both a SAME-block and a DIFFERENT-block edit are covered;
 * the no-edit control pins the byte-sacred write path itself.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  pollUntil,
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

/** Depth-first find the first Y.XmlText whose string contains `marker`. */
function findXmlTextContaining(
  node: Y.XmlFragment | Y.XmlElement,
  marker: string,
): Y.XmlText | null {
  const len = node.length;
  for (let i = 0; i < len; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlText) {
      if (child.toString().includes(marker)) return child;
    } else if (child instanceof Y.XmlElement) {
      const found = findXmlTextContaining(child, marker);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Seed `body` via the agent path (bytes land verbatim), assert the NBSP is
 * intact at rest, then optionally append " EDITWORD" to the span containing
 * `editMarker` through the XmlFragment (the WYSIWYG write surface). Awaits the
 * server Observer A round-trip + local settlement, and returns the client's
 * Y.Text('source') string.
 */
async function seedThenMaybeEdit(opts: { body: string; editMarker?: string }): Promise<string> {
  const docName = `nbsp-${crypto.randomUUID()}`;
  const client: TestClient = await createTestClient(server.port, docName, {
    skipInvariantWatcher: true,
  });
  try {
    await agentWriteMd(server.port, opts.body, { docName, position: 'replace' });
    // Wait for the seed to land on the client, then confirm the seed itself is
    // byte-sacred — the RED assertion below is only meaningful if the NBSP was
    // present after the agent write and lost by the WYSIWYG edit, not absent
    // from the start.
    await pollUntil(() => client.ytext.toString().includes('bar'), 5000);
    await awaitDocQuiescence(client.doc);
    expect(client.ytext.toString()).toContain(NBSP);

    if (opts.editMarker !== undefined) {
      const target = findXmlTextContaining(client.fragment, opts.editMarker);
      if (!target) {
        throw new Error(`edit marker not found in fragment: ${opts.editMarker}`);
      }
      target.insert(target.length, ' EDITWORD');
      // Wait for the server Observer A settlement to echo back, then settle any
      // follow-on observer cascade locally.
      await pollUntil(() => client.ytext.toString().includes('EDITWORD'), 5000);
      await awaitDocQuiescence(client.doc);
      // Guard against a false-RED: prove the edit actually round-tripped.
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

  /**
   * Byte-sacred control: with no WYSIWYG edit, Observer A never fires and the
   * verbatim NBSP survives in Y.Text. Pins the byte-sacred write path itself.
   *
   */
  test('document NBSP survives verbatim with no WYSIWYG edit (byte-sacred control)', async () => {
    const ytext = await seedThenMaybeEdit({
      body: `Alpha foo${NBSP}bar keepme\n`,
    });
    expect(ytext).toContain(NBSP);
  }, 25_000);
});
