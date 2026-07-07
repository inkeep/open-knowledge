/**
 * C14: Concurrent edits on a 4-Step indented-children MDX-JSX doc.
 *
 * Makes the amplifier executable at integration fidelity (real
 * Hocuspocus + server-authoritative observer bridge) over the corrupting
 * construct, not just plain paragraphs. Two real clients edit the 4-Step doc
 * concurrently across a pause/resume divergence window while an agent write
 * lands in parallel; on reconnect the bridge must settle to a bounded
 * fixed point. Deterministic seed (fixed interleaving), not randomized.
 *
 * Oracles: bridge invariant per client + byte budget + no sibling
 * reorder / no duplication of the four Steps.
 *
 * Per-test docName isolation; client lifecycle in try/finally.
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

const STEP_MARKERS = ['STEP-ONE-BODY', 'STEP-TWO-BODY', 'STEP-THREE-BODY', 'STEP-FOUR-BODY'];

// The 4-Step indented-children shape (mirrors the real github-sync.mdx
// fixture), each step body carrying a unique anchor for the reorder/dup oracle.
const FOUR_STEP_SEED = [
  '<Steps>',
  '',
  '<Step>',
  '',
  'STEP-ONE-BODY first instruction.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'STEP-TWO-BODY second instruction.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'STEP-THREE-BODY third instruction.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'STEP-FOUR-BODY fourth instruction.',
  '',
  '</Step>',
  '',
  '</Steps>',
  '',
].join('\n');

function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

async function awaitAllContain(clients: TestClient[], markers: string[]): Promise<void> {
  for (const marker of markers) {
    for (const client of clients) {
      await pollUntil(() => client.ytext.toString().includes(marker), 5000);
    }
  }
  await wait(600);
}

describe('C14: concurrent edits on a 4-Step indented-JSX doc', () => {
  test('two clients + agent write across a divergence window converge to a bounded, in-order fixed point', async () => {
    const docName = `c14-4step-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true, syncControl: true },
    });
    try {
      // Seed the 4-Step indented-JSX doc and let both clients converge on it.
      await agentWriteMd(server.port, FOUR_STEP_SEED, { docName, position: 'replace' });
      await awaitAllContain(clients, STEP_MARKERS);

      // Open a divergence window: client 0 stops syncing, both clients edit
      // concurrently, and an agent write lands in parallel.
      clients[0].pauseSync();
      appendParagraph(clients[0], 'C14-WYSIWYG-A');
      appendParagraph(clients[1], 'C14-WYSIWYG-B');
      await agentWriteMd(server.port, '\n\nC14-AGENT-EDIT trailing.\n', {
        docName,
        position: 'append',
      });
      await wait(300);

      // Reconnect — the divergent replicas must reconcile through the bridge.
      clients[0].resumeSync();
      await awaitAllContain(clients, [
        ...STEP_MARKERS,
        'C14-WYSIWYG-A',
        'C14-WYSIWYG-B',
        'C14-AGENT-EDIT',
      ]);

      const ytexts = clients.map((c) => c.ytext.toString());
      expect(ytexts[1]).toBe(ytexts[0]);
      for (const client of clients) assertBridgeInvariant(client.ytext, client.fragment);

      const converged = ytexts[0];

      // no sibling reorder + no duplication: each Step anchor appears
      // exactly once, and the four Steps stay in their authored order.
      const positions = STEP_MARKERS.map((m) => {
        expect(converged.split(m).length - 1).toBe(1);
        return converged.indexOf(m);
      });
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i]).toBeGreaterThan(positions[i - 1]);
      }
      // Each concurrent edit landed exactly once (no amplification).
      for (const m of ['C14-WYSIWYG-A', 'C14-WYSIWYG-B', 'C14-AGENT-EDIT']) {
        expect(converged.split(m).length - 1).toBe(1);
      }

      // byte budget: bounded by the authored input, no runaway growth.
      const authoredBytes =
        Buffer.byteLength(FOUR_STEP_SEED) +
        Buffer.byteLength('C14-WYSIWYG-A C14-WYSIWYG-B C14-AGENT-EDIT trailing.');
      expect(Buffer.byteLength(converged)).toBeLessThanOrEqual(authoredBytes * 3);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);
});
