import { setTimeout as wait } from 'node:timers/promises';
import { buildProjection } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  createTestClients,
  createTestServer,
  editProjectionBlocks,
  mdManager,
  pollUntil,
  projectionBlocks,
  readTestDoc,
  schema,
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

const blanks = (n: number) => Array.from({ length: n }, () => schema.node('paragraph'));

function countBlankLineNodes(source: string): number {
  const { doc } = buildProjection(source, mdManager);
  return projectionBlocks(doc).filter((b) => b.type.name === 'paragraph' && b.content.size === 0)
    .length;
}

async function settle(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(25);
  }
}

async function seedDocument(raw: string): Promise<TestClient[]> {
  const docName = `doc-edge-${crypto.randomUUID()}`;
  const clients = await createTestClients(server.port, { count: 2, docName });
  await agentWriteMd(server.port, raw, { docName, position: 'replace' });
  await pollUntil(() => clients.every((c) => c.ytext.toString() === raw), 10_000);
  return clients;
}

async function expectEverywhereExactly(
  clients: TestClient[],
  expected: string,
  blankNodes: number,
  diskTimeoutMs: number,
): Promise<void> {
  for (const c of clients) {
    expect(c.ytext.toString()).toBe(expected);
    expect(countBlankLineNodes(c.ytext.toString())).toBe(blankNodes);
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
      editProjectionBlocks(a, (blocks) => [...blocks, ...blanks(2)]);

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
      editProjectionBlocks(a, (blocks) => [...blocks, ...blanks(2)]);

      const expected = '---\ntitle: Edge\n---\n\nAbove.\n\nBelow.\n\n\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 10_000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('CHARACTERIZATION: a leading blank run is held in the projection and never written', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      editProjectionBlocks(a, (blocks) => [...blanks(2), ...blocks]);

      const unchanged = 'Above.\n\nBelow.\n';
      await wait(1000);
      await expectEverywhereExactly(clients, unchanged, 0, 10_000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a trailing blank run on a single-block document reaches the source bytes', async () => {
    const clients = await seedDocument('Hello.\n');
    try {
      const a = clients[0];
      editProjectionBlocks(a, (blocks) => [...blocks, ...blanks(3)]);

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
      editProjectionBlocks(a, (blocks) => [...blocks, ...blanks(2)]);
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

  test('an external write that carries a trailing run lands it on every client', async () => {
    const clients = await seedDocument('Alpha.\n\nOmega.\n');
    try {
      const a = clients[0];
      editProjectionBlocks(a, (blocks) => [...blocks, ...blanks(2)]);
      await settle(() => a.ytext.toString() === 'Alpha.\n\nOmega.\n\n\n', 4000);

      const expected = 'Alpha edited.\n\nOmega.\n\n\n';
      await agentWriteMd(server.port, expected, { docName: a.docName, position: 'replace' });

      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 8000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('CHARACTERIZATION: a text edit spanning to a new trailing run carries the text, not the run', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      editProjectionBlocks(a, (blocks) => [
        schema.node('paragraph', null, schema.text(`Z${blocks[0].textContent}`)),
        ...blocks.slice(1),
        ...blanks(2),
      ]);

      const expected = 'ZAbove.\n\nBelow.\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 0, 8000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('CONTROL: an interior blank run still reaches the source bytes unchanged', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      editProjectionBlocks(a, (blocks) => [blocks[0], ...blanks(2), ...blocks.slice(1)]);

      const expected = 'Above.\n\n\n\nBelow.\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 10_000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
