import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  createTestClients,
  createTestServer,
  pollUntil,
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

const FM = '---\ntitle: Boundary alignment\n---\n';
const RAW = `${FM}\nFirst paragraph body.\n\nSecond paragraph stays.\n`;
const EXPECTED_CONVERGED = `${FM}\nZFirst paragraph body. \n\nSecond paragraph stays.\n`;

function findTextNodeContaining(
  node: Y.XmlFragment | Y.XmlElement,
  needle: string,
): Y.XmlText | null {
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlText && child.toString().includes(needle)) return child;
    if (child instanceof Y.XmlElement) {
      const found = findTextNodeContaining(child, needle);
      if (found) return found;
    }
  }
  return null;
}

describe('C13: Path B doc-boundary alignment across clients', () => {
  test('concurrent source + WYSIWYG edits on an FM doc — no duplication, boundary blank line survives on every client', async () => {
    const docName = `c13-boundary-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      await agentWriteMd(server.port, RAW, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === RAW), 5000);
      await wait(500);

      const b = clients[1];
      b.doc.transact(() => {
        b.ytext.insert(
          b.ytext.toString().indexOf('First paragraph body.') + 'First paragraph body.'.length,
          ' ',
        );
      });
      await pollUntil(
        () => clients.every((c) => c.ytext.toString().includes('First paragraph body. \n')),
        5000,
      );
      await wait(300);

      const a = clients[0];
      a.doc.transact(() => {
        const textNode = findTextNodeContaining(a.fragment, 'First paragraph');
        if (!textNode) throw new Error('no fragment text node containing "First paragraph"');
        textNode.insert(0, 'Z');
      });
      await pollUntil(() => clients.every((c) => c.ytext.toString().includes('ZFirst')), 5000);
      await wait(500);
      await pollUntil(
        () => clients.every((c) => serializeFragment(c.fragment).includes('ZFirst paragraph body')),
        5000,
      );

      for (const c of clients) {
        const text = c.ytext.toString();
        const para1Count = text.split('First paragraph body').length - 1;
        expect(para1Count).toBe(1);
        expect(text).toContain('---\n\n');
        expect(text).toContain('ZFirst paragraph body. \n');
        expect(text).toBe(EXPECTED_CONVERGED);

        const fragMd = serializeFragment(c.fragment);
        expect(fragMd.split('First paragraph body').length - 1).toBe(1);
        expect(fragMd).toContain('ZFirst paragraph body');
      }
      expect(clients[0].ytext.toString()).toBe(clients[1].ytext.toString());
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
