import { appendFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  createTestClients,
  createTestServer,
  pollUntil,
  serializeFragment,
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

const DIAG = process.env.QA_DIAG_OUT;
function diag(probe: string, data: Record<string, unknown>): void {
  if (!DIAG) return;
  appendFileSync(DIAG, `${JSON.stringify({ probe, ...data })}\n`);
}

const para = () => new Y.XmlElement('paragraph');

function countBlankLineNodes(fragment: Y.XmlFragment): number {
  let count = 0;
  for (let i = 0; i < fragment.length; i++) {
    if (String(fragment.get(i)) === '<paragraph></paragraph>') count += 1;
  }
  return count;
}

async function settle(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

async function seedDocument(raw: string): Promise<TestClient[]> {
  const docName = `qa-ctrl-${crypto.randomUUID()}`;
  const clients = await createTestClients(server.port, {
    count: 2,
    docName,
    perClientOptions: { skipInvariantWatcher: true },
  });
  await agentWriteMd(server.port, raw, { docName, position: 'replace' });
  await pollUntil(() => clients.every((c) => c.ytext.toString() === raw), 10_000);
  return clients;
}

describe('classification controls', () => {
  test('C2: WYSIWYG delete of a W1-authored tail run propagates to the source bytes', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });
      const withRun = 'Above.\n\nBelow.\n\n\n';
      expect(
        await settle(() => clients.every((c) => c.ytext.toString() === withRun), 6000),
        'precondition: run landed',
      ).toBe(true);

      a.doc.transact(() => {
        a.fragment.delete(a.fragment.length - 2, 2);
      });
      const back = 'Above.\n\nBelow.\n';
      const converged = await settle(() => clients.every((c) => c.ytext.toString() === back), 6000);
      diag('C2', {
        converged,
        ytext: clients.map((c) => c.ytext.toString()),
        blanks: clients.map((c) => countBlankLineNodes(c.fragment)),
      });
      for (const c of clients) {
        expect(c.ytext.toString(), 'WYSIWYG delete of the run reaches the bytes').toBe(back);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);

  test('C3: WYSIWYG delete of the last paragraph on an in-sync doc propagates normally', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const b = clients[1];
      b.doc.transact(() => {
        b.fragment.delete(b.fragment.length - 1, 1);
      });
      const expected = 'Above.\n';
      const converged = await settle(
        () => clients.every((c) => c.ytext.toString() === expected),
        6000,
      );
      diag('C3', {
        converged,
        ytext: clients.map((c) => c.ytext.toString()),
        fragment: clients.map((c) => serializeFragment(c.fragment)),
      });
      for (const c of clients) {
        expect(c.ytext.toString(), 'in-sync paragraph delete baseline').toBe(expected);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);
});
