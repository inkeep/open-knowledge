import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  createTestClients,
  createTestServer,
  pollUntil,
  readTestDoc,
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

const para = () => new Y.XmlElement('paragraph');

function countBlankLineNodes(fragment: Y.XmlFragment): number {
  let count = 0;
  for (let i = 0; i < fragment.length; i++) {
    if (String(fragment.get(i)) === '<paragraph></paragraph>') count += 1;
  }
  return count;
}

async function settle(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(25);
  }
}

async function seedDocument(raw: string, fragmentBody = raw): Promise<TestClient[]> {
  const docName = `doc-edge-${crypto.randomUUID()}`;
  const clients = await createTestClients(server.port, {
    count: 2,
    docName,
    perClientOptions: { skipInvariantWatcher: true },
  });
  await agentWriteMd(server.port, raw, { docName, position: 'replace' });
  await pollUntil(
    () =>
      clients.every(
        (c) => c.ytext.toString() === raw && serializeFragment(c.fragment) === fragmentBody,
      ),
    10_000,
  );
  return clients;
}

async function expectEverywhereExactly(
  clients: TestClient[],
  expected: string,
  blankNodes: number,
  diskTimeoutMs: number,
  expectedFragment = expected,
): Promise<void> {
  for (const c of clients) {
    expect(c.ytext.toString()).toBe(expected);
    expect(serializeFragment(c.fragment)).toBe(expectedFragment);
    expect(countBlankLineNodes(c.fragment)).toBe(blankNodes);
  }
  const docName = clients[0].docName;
  await settle(() => readTestDoc(server.contentDir, docName) === expected, diskTimeoutMs);
  expect(readTestDoc(server.contentDir, docName)).toBe(expected);
}

describe('doc-edge blank runs on the CRDT path', () => {
  test('a trailing blank run authored in the WYSIWYG reaches the source bytes', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });

      const expected = 'Above.\n\nBelow.\n\n\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 10_000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a trailing blank run on a frontmatter document reaches the source bytes', async () => {
    const clients = await seedDocument(
      '---\ntitle: Edge\n---\n\nAbove.\n\nBelow.\n',
      'Above.\n\nBelow.\n',
    );
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });

      const expected = '---\ntitle: Edge\n---\n\nAbove.\n\nBelow.\n\n\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 10_000, 'Above.\n\nBelow.\n\n\n');
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a leading blank run authored in the WYSIWYG reaches the source bytes', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(0, [para(), para()]);
      });

      const expected = '\n\nAbove.\n\nBelow.\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 10_000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a trailing blank run on a single-block document reaches the source bytes', async () => {
    const clients = await seedDocument('Hello.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para(), para()]);
      });

      const expected = 'Hello.\n\n\n\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 3, 10_000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a source-mode edit beside a trailing blank run does not destroy it', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      const b = clients[1];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });
      await settle(() => a.ytext.toString() === 'Above.\n\nBelow.\n\n\n', 4000);

      b.doc.transact(() => {
        b.ytext.insert(0, 'X');
      });

      const expected = 'XAbove.\n\nBelow.\n\n\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 8000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a fragment-only blank run survives the three-way merge seam at either position', async () => {
    async function mergeSeam(insertAt: number, ytext: string, fragment: string): Promise<void> {
      const clients = await seedDocument('Above.\n\nBelow.\n');
      try {
        const a = clients[0];
        a.doc.transact(() => {
          a.fragment.insert(insertAt, [para(), para()]);
          a.ytext.insert(a.ytext.toString().length - 1, '!');
        });

        await settle(
          () =>
            clients.every(
              (c) => c.ytext.toString() === ytext && serializeFragment(c.fragment) === fragment,
            ),
          8000,
        );
        for (const c of clients) {
          expect(c.ytext.toString()).toBe(ytext);
          expect(serializeFragment(c.fragment)).toBe(fragment);
          expect(countBlankLineNodes(c.fragment)).toBe(2);
        }
        const docName = clients[0].docName;
        await settle(() => readTestDoc(server.contentDir, docName) === ytext, 8000);
        expect(readTestDoc(server.contentDir, docName)).toBe(ytext);
      } finally {
        for (const c of clients) await c.cleanup();
      }
    }

    await mergeSeam(0, '\n\nAbove.\n\nBelow.!\n', '\n\nAbove.\n\nBelow.!\n');
    await mergeSeam(1, 'Above.\n\n\n\nBelow.!\n', 'Above.\n\n\n\nBelow.!\n');
  });

  test('an external write that carries a trailing run lands it in every fragment', async () => {
    const clients = await seedDocument('Alpha.\n\nOmega.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });
      await settle(() => a.ytext.toString() === 'Alpha.\n\nOmega.\n\n\n', 4000);

      const expected = 'Alpha edited.\n\nOmega.\n\n\n';
      await agentWriteMd(server.port, expected, { docName: a.docName, position: 'replace' });

      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 8000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a text edit and a trailing run in one transaction both reach the source bytes', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        const first = a.fragment.get(0) as { get(i: number): unknown };
        (first.get(0) as { insert(i: number, s: string): void }).insert(0, 'Z');
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });

      const expected = 'ZAbove.\n\nBelow.\n\n\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 8000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('CONTROL: an interior blank run still reaches the source bytes unchanged', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(1, [para(), para()]);
      });

      const expected = 'Above.\n\n\n\nBelow.\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 10_000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
