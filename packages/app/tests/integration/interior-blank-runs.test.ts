import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function countBlankLineNodes(fragment: Y.XmlFragment): number {
  let count = 0;
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (
      child instanceof Object &&
      'toString' in child &&
      child.toString() === '<paragraph></paragraph>'
    ) {
      count += 1;
    }
  }
  return count;
}

describe('interior blank runs on the CRDT path', () => {
  test('a blank run written by one peer reaches the other as blank lines, byte for byte', async () => {
    const docName = `blank-run-peers-${crypto.randomUUID()}`;
    const raw = 'First block.\n\n\n\n\nSecond block.\n';
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      await agentWriteMd(server.port, raw, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === raw), 5000);
      await wait(500);

      for (const c of clients) {
        expect(countBlankLineNodes(c.fragment)).toBe(3);
        expect(serializeFragment(c.fragment)).toBe(raw);
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
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      await agentWriteMd(server.port, raw, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === raw), 5000);
      await wait(500);

      const a = clients[0];
      a.doc.transact(() => {
        const first = a.fragment.get(0);
        const text = (first as { get(i: number): unknown }).get(0);
        (text as { insert(i: number, s: string): void }).insert(0, 'Z');
      });
      await pollUntil(() => clients.every((c) => c.ytext.toString().includes('ZAlpha')), 5000);
      await wait(500);
      await pollUntil(
        () => clients.every((c) => serializeFragment(c.fragment).includes('ZAlpha')),
        5000,
      );

      const expected = 'ZAlpha.\n\n\n\nOmega.\n';
      for (const c of clients) {
        expect(c.ytext.toString()).toBe(expected);
        expect(serializeFragment(c.fragment)).toBe(expected);
        expect(countBlankLineNodes(c.fragment)).toBe(2);
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
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      await agentWriteMd(server.port, raw, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === raw), 5000);
      await wait(500);

      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(1, [new Y.XmlElement('paragraph'), new Y.XmlElement('paragraph')]);
      });

      const expected = 'Above.\n\n\n\nBelow.\n';
      await pollUntil(() => clients.every((c) => c.ytext.toString() === expected), 5000);
      await wait(500);
      for (const c of clients) {
        expect(c.ytext.toString()).toBe(expected);
        expect(countBlankLineNodes(c.fragment)).toBe(2);
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
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      await agentWriteMd(server.port, raw, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === raw), 5000);
      await wait(500);

      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(1, [new Y.XmlElement('paragraph'), new Y.XmlElement('paragraph')]);
      });

      const expected = 'Above.\n\n\n\nBelow.\n\n\n';
      await pollUntil(() => clients.every((c) => c.ytext.toString() === expected), 5000).catch(
        () => {},
      );
      await wait(500);
      for (const c of clients) {
        expect(c.ytext.toString()).toBe(expected);
        expect(serializeFragment(c.fragment)).toBe(expected);
        expect(countBlankLineNodes(c.fragment)).toBe(4);
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
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      await pollUntil(() => clients[0].ytext.toString() === raw, 10_000);
      await wait(500);
      expect(countBlankLineNodes(clients[0].fragment)).toBe(4);
      expect(serializeFragment(clients[0].fragment)).toBe(raw);
      expect(readTestDoc(server.contentDir, docName)).toBe(raw);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
