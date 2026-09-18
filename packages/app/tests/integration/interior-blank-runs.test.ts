import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('interior blank runs on the CRDT path', () => {
  test('a blank run written by one peer reaches the other as blank lines, byte for byte', async () => {
    const docName = `blank-run-peers-${crypto.randomUUID()}`;
    const raw = 'First block.\n\n\n\n\nSecond block.\n';
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
    });
    try {
      await agentWriteMd(server.port, raw, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === raw), 5000);
      await wait(500);

      for (const c of clients) {
        expect(countBlankLineNodes(c.ytext.toString())).toBe(3);
        expect(c.ytext.toString()).toBe(raw);
      }
      expect(clients[0].ytext.toString()).toBe(clients[1].ytext.toString());
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a WYSIWYG edit beside a blank run converges on both peers without disturbing it', async () => {
    const docName = `blank-run-edit-${crypto.randomUUID()}`;
    const raw = 'Alpha.\n\n\n\nOmega.\n';
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
    });
    try {
      await agentWriteMd(server.port, raw, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === raw), 5000);
      await wait(500);

      const a = clients[0];
      editProjectionBlocks(a, (blocks) => [
        schema.node('paragraph', null, schema.text(`Z${blocks[0].textContent}`)),
        ...blocks.slice(1),
      ]);
      await pollUntil(() => clients.every((c) => c.ytext.toString().includes('ZAlpha')), 5000);
      await wait(500);

      const expected = 'ZAlpha.\n\n\n\nOmega.\n';
      for (const c of clients) {
        expect(c.ytext.toString()).toBe(expected);
        expect(countBlankLineNodes(c.ytext.toString())).toBe(2);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('blank lines created in the WYSIWYG reach the source bytes', async () => {
    const docName = `blank-run-authored-${crypto.randomUUID()}`;
    const raw = 'Above.\n\nBelow.\n';
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
    });
    try {
      await agentWriteMd(server.port, raw, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === raw), 5000);
      await wait(500);

      const a = clients[0];
      editProjectionBlocks(a, (blocks) => [blocks[0], ...blanks(2), ...blocks.slice(1)]);

      const expected = 'Above.\n\n\n\nBelow.\n';
      await pollUntil(() => clients.every((c) => c.ytext.toString() === expected), 5000);
      await wait(500);
      for (const c of clients) {
        expect(c.ytext.toString()).toBe(expected);
        expect(countBlankLineNodes(c.ytext.toString())).toBe(2);
      }
      await pollUntil(() => readTestDoc(server.contentDir, docName) === expected, 10_000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a trailing blank run in the file does not hide a new interior one', async () => {
    const docName = `blank-run-edge-${crypto.randomUUID()}`;
    const raw = 'Above.\n\nBelow.\n\n\n';
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
    });
    try {
      await agentWriteMd(server.port, raw, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === raw), 5000);
      await wait(500);

      const a = clients[0];
      editProjectionBlocks(a, (blocks) => [blocks[0], ...blanks(2), ...blocks.slice(1)]);

      const expected = 'Above.\n\n\n\nBelow.\n\n\n';
      await pollUntil(() => clients.every((c) => c.ytext.toString() === expected), 5000).catch(
        () => {},
      );
      await wait(500);
      for (const c of clients) {
        expect(c.ytext.toString()).toBe(expected);
        expect(countBlankLineNodes(c.ytext.toString())).toBe(4);
      }
      await pollUntil(() => readTestDoc(server.contentDir, docName) === expected, 10_000).catch(
        () => {},
      );
      expect(readTestDoc(server.contentDir, docName)).toBe(expected);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a document already on disk gains its blank lines on first open, with no migration step', async () => {
    const docName = `blank-run-disk-${crypto.randomUUID()}`;
    const raw = 'On disk before the upgrade.\n\n\n\n\n\nStill here.\n';
    writeFileSync(join(server.contentDir, `${docName}.md`), raw, 'utf8');

    const clients = await createTestClients(server.port, {
      count: 1,
      docName,
    });
    try {
      await pollUntil(() => clients[0].ytext.toString() === raw, 10_000);
      await wait(500);
      expect(countBlankLineNodes(clients[0].ytext.toString())).toBe(4);
      expect(clients[0].ytext.toString()).toBe(raw);
      expect(readTestDoc(server.contentDir, docName)).toBe(raw);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
