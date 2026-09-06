import { setTimeout as wait } from 'node:timers/promises';
import { buildProjection } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { captureSelectionContext, findQuoteRange } from '@/comments/anchor-search';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  assertAllConverged,
  createTestClients,
  createTestServer,
  mdManager,
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

const QUOTE = 'the garlic paste';
const SEED =
  '# Notes\n\n' +
  'Stir well and add the garlic paste to the pan before serving.\n\n' +
  'Later, again: add the garlic paste to the pan before serving.\n';

interface StoredAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

function docOf(client: TestClient) {
  return buildProjection(client.ytext.toString(), mdManager).doc;
}

function anchorOnFirstOccurrence(client: TestClient): StoredAnchor {
  const doc = docOf(client);
  const range = findQuoteRange(doc, QUOTE);
  if (range === null) throw new Error('fixture: the quote does not resolve in the seed document');
  return { quote: QUOTE, ...captureSelectionContext(doc, range.from, range.to) };
}

function paragraphAt(client: TestClient, pos: number): string {
  return docOf(client).resolve(pos).parent.textContent;
}

async function seeded(name: string): Promise<TestClient[]> {
  const docName = `${name}-${crypto.randomUUID()}`;
  const clients = await createTestClients(server.port, { count: 2, docName });
  clients[0].doc.transact(() => clients[0].ytext.insert(0, SEED));
  await assertAllConverged(clients, { timeout: 5000 });
  return clients;
}

function replaceInBody(client: TestClient, find: string, replacement: string): void {
  const at = client.ytext.toString().indexOf(find);
  if (at < 0) throw new Error(`fixture: ${find} is not in the body`);
  client.doc.transact(() => {
    client.ytext.delete(at, find.length);
    client.ytext.insert(at, replacement);
  });
}

describe('a comment anchor across a remote peer edit', () => {
  test('holds on its own passage when the peer edits elsewhere in the same paragraph', async () => {
    const [author, peer] = await seeded('anchor-context');
    try {
      const anchor = anchorOnFirstOccurrence(author);

      replaceInBody(peer, 'Stir well and add', 'Stir gently and thoroughly, then add');
      await pollUntil(() => author.ytext.toString().includes('thoroughly'), 5000);
      await wait(100);

      const range = findQuoteRange(docOf(author), anchor.quote, anchor);
      expect(range).not.toBeNull();
      expect(paragraphAt(author, range?.from ?? 0)).toContain('Stir gently');
      expect(paragraphAt(author, range?.from ?? 0)).not.toContain('Later, again');
    } finally {
      await Promise.all([author.cleanup(), peer.cleanup()]);
    }
  });

  test('CHARACTERIZATION: re-anchors onto the twin when the peer rewrites the quoted span', async () => {
    const [author, peer] = await seeded('anchor-rewrite');
    try {
      const anchor = anchorOnFirstOccurrence(author);

      replaceInBody(
        peer,
        'Stir well and add the garlic paste',
        'Stir well and add the shallot mix',
      );
      await pollUntil(() => author.ytext.toString().includes('shallot mix'), 5000);
      await wait(100);

      const range = findQuoteRange(docOf(author), anchor.quote, anchor);
      expect(range).not.toBeNull();
      expect(paragraphAt(author, range?.from ?? 0)).toContain('Later, again');
    } finally {
      await Promise.all([author.cleanup(), peer.cleanup()]);
    }
  });

  test('orphans instead of moving when the peer deletes the quoted span outright', async () => {
    const [author, peer] = await seeded('anchor-delete');
    try {
      const anchor = anchorOnFirstOccurrence(author);

      replaceInBody(peer, 'add the garlic paste to the pan', 'add to the pan');
      await pollUntil(() => author.ytext.toString().includes('well and add to the pan'), 5000);
      await wait(100);

      const range = findQuoteRange(docOf(author), anchor.quote, anchor);
      expect(range).toBeNull();
    } finally {
      await Promise.all([author.cleanup(), peer.cleanup()]);
    }
  });

  test('holds when the peer edits the paragraph that carries the twin', async () => {
    const [author, peer] = await seeded('anchor-twin-paragraph');
    try {
      const anchor = anchorOnFirstOccurrence(author);

      replaceInBody(peer, 'Later, again: add', 'Much later on, add');
      await pollUntil(() => author.ytext.toString().includes('Much later on'), 5000);
      await wait(100);

      const range = findQuoteRange(docOf(author), anchor.quote, anchor);
      expect(range).not.toBeNull();
      expect(paragraphAt(author, range?.from ?? 0)).toContain('Stir well');
    } finally {
      await Promise.all([author.cleanup(), peer.cleanup()]);
    }
  });
});
