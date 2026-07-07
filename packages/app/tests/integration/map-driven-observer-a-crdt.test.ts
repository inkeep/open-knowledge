/**
 * Cross-CRDT integration: map-driven Observer A under multi-client topology.
 *
 * Exercises the map-driven Path A (the default Observer A write path)
 * end-to-end through Hocuspocus with two concurrent clients editing
 * distinct blocks. Verifies:
 *   - Convergence to byte-identical Y.Text across replicas (cross-replica
 *     consistency under the map-driven write path).
 *   - Per-replica ≡ post-convergence for non-overlapping splices —
 *     the merged result preserves the bytes the OTHER client contributed
 *     (no client's splice clobbers the other's).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertBridgeInvariant,
  createTestClients,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

async function awaitConvergence(clients: TestClient[], markers: string[]): Promise<void> {
  for (const marker of markers) {
    for (const client of clients) {
      await pollUntil(() => client.ytext.toString().includes(marker), 5000);
    }
  }
  await wait(500);
}

describe('map-driven Observer A — cross-CRDT integration', () => {
  test('(a) two-client concurrent edits converge to byte-identical Y.Text', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      appendParagraph(clients[0], 'MAP-DRIVEN-A-WYSIWYG');
      appendParagraph(clients[1], 'MAP-DRIVEN-B-WYSIWYG');

      await awaitConvergence(clients, ['MAP-DRIVEN-A-WYSIWYG', 'MAP-DRIVEN-B-WYSIWYG']);

      const ytexts = clients.map((c) => c.ytext.toString());
      expect(ytexts[1]).toBe(ytexts[0]);

      for (const client of clients) {
        assertBridgeInvariant(client.ytext, client.fragment);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('(b) per-replica AC1 ≡ post-convergence AC1 — non-overlapping splices preserve each others bytes', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      appendParagraph(clients[0], 'AC1-NONOVERLAP-CLIENT-A');
      await awaitConvergence(clients, ['AC1-NONOVERLAP-CLIENT-A']);

      appendParagraph(clients[0], 'AC1-NONOVERLAP-EDIT-A');
      appendParagraph(clients[1], 'AC1-NONOVERLAP-EDIT-B');

      await awaitConvergence(clients, [
        'AC1-NONOVERLAP-CLIENT-A',
        'AC1-NONOVERLAP-EDIT-A',
        'AC1-NONOVERLAP-EDIT-B',
      ]);

      for (const client of clients) {
        const text = client.ytext.toString();
        expect(text).toContain('AC1-NONOVERLAP-CLIENT-A');
        expect(text).toContain('AC1-NONOVERLAP-EDIT-A');
        expect(text).toContain('AC1-NONOVERLAP-EDIT-B');
      }

      const ytexts = clients.map((c) => c.ytext.toString());
      expect(ytexts[1]).toBe(ytexts[0]);

      for (const client of clients) {
        assertBridgeInvariant(client.ytext, client.fragment);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('(c) indented-JSX doc converges within byte budget, no Step duplication (PRD-7110 amplifier)', async () => {
    const docName = `map-driven-jsx-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      // Seed the corrupting construct: an indented-children <Steps>/<Step> doc
      // this round-tripped beyond tolerance and
      // the multi-drain Observer-A re-derivation amplified it; post-fix it folds.
      const seed =
        '<Steps>\n\n<Step>\n\nSTEP-ALPHA-BODY paragraph.\n\n</Step>\n\n<Step>\n\nSTEP-BRAVO-BODY paragraph.\n\n</Step>\n\n</Steps>\n';
      await agentWriteMd(server.port, seed, { docName, position: 'replace' });
      await awaitConvergence(clients, ['STEP-ALPHA-BODY', 'STEP-BRAVO-BODY']);

      // Concurrent WYSIWYG edits from both clients — the amplifier trigger.
      appendParagraph(clients[0], 'MAP-JSX-EDIT-A');
      appendParagraph(clients[1], 'MAP-JSX-EDIT-B');
      await awaitConvergence(clients, [
        'STEP-ALPHA-BODY',
        'STEP-BRAVO-BODY',
        'MAP-JSX-EDIT-A',
        'MAP-JSX-EDIT-B',
      ]);

      const ytexts = clients.map((c) => c.ytext.toString());
      expect(ytexts[1]).toBe(ytexts[0]);
      for (const client of clients) assertBridgeInvariant(client.ytext, client.fragment);

      // byte-budget + no-duplication on the corrupting construct: every
      // authored anchor appears EXACTLY once (the amplifier would multiply them)
      // and the converged bytes stay within a small multiple of the authored input.
      const converged = ytexts[0];
      for (const marker of [
        'STEP-ALPHA-BODY',
        'STEP-BRAVO-BODY',
        'MAP-JSX-EDIT-A',
        'MAP-JSX-EDIT-B',
      ]) {
        expect(converged.split(marker).length - 1).toBe(1);
      }
      const authoredBytes =
        Buffer.byteLength(seed) + Buffer.byteLength('MAP-JSX-EDIT-A MAP-JSX-EDIT-B');
      expect(Buffer.byteLength(converged)).toBeLessThanOrEqual(authoredBytes * 3);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);
});
