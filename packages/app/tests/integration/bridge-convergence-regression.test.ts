import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment } from '@tiptap/y-tiptap';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertBridgeInvariant,
  createTestClient,
  createTestServer,
  mdManager,
  pollUntil,
  schema,
  type TestClient,
  type TestServer,
  testReset,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function applyMarkdownToFragment(client: TestClient, md: string): void {
  const parsed = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(parsed);
  client.doc.transact(() => {
    const meta = { mapping: new Map(), isOMark: new Map() };
    updateYFragment(client.doc, client.fragment, pmNode, meta);
  });
}

describe('Bridge convergence regression', () => {
  test('P0: user XmlFragment edit + agent write — both preserved (Bug-A fix)', async () => {
    const docName = `test-p0-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName);

    try {
      applyMarkdownToFragment(client, 'user line one edited by user\n');

      await agentWriteMd(server.port, 'agent line X\n', {
        docName,
        position: 'append',
      });

      await wait(800);

      const finalYtext = client.ytext.toString();
      expect(finalYtext).toContain('edited by user');
      expect(finalYtext).toContain('agent line X');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('P0-stress: rapid interleaved user + agent writes — bridge invariant holds (Bug-A stress)', async () => {
    const docName = `test-p0-stress-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName);

    try {
      const rounds = 10;
      for (let i = 0; i < rounds; i++) {
        applyMarkdownToFragment(client, `round ${i}: user text ${i}\n`);
        await agentWriteMd(server.port, `round ${i}: agent-${i}\n`, {
          docName,
          position: 'append',
        });
      }

      await wait(1200);

      const finalYtext = client.ytext.toString();

      expect(finalYtext).toContain('agent-9');

      expect(finalYtext).toContain('user text 9');

      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('P1: user XmlFragment edit + file-watcher disk update — bridge invariant holds', async () => {
    await testReset(server.port);
    await wait(200);
    const client = await createTestClient(server.port, 'test-doc');

    try {
      applyMarkdownToFragment(client, 'user typed this\n');

      const filePath = join(server.contentDir, 'test-doc.md');
      writeFileSync(filePath, 'file-watcher overwrote this\n', 'utf-8');

      await wait(2000);

      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('CONTROL: peer+peer XmlFragment edits — XmlFragments converge, agent write reconciles Y.Text', async () => {
    const docName = `test-ctrl-${crypto.randomUUID()}`;
    const clientA = await createTestClient(server.port, docName);
    const clientB = await createTestClient(server.port, docName);

    try {
      await agentWriteMd(server.port, 'shared baseline\n', {
        docName,
        position: 'replace',
      });
      await pollUntil(
        () =>
          clientA.ytext.toString().includes('shared baseline') &&
          clientB.ytext.toString().includes('shared baseline'),
        5000,
      );

      applyMarkdownToFragment(clientA, 'shared baseline AAA from A\n');
      applyMarkdownToFragment(clientB, 'shared baseline BBB from B\n');

      await wait(1000);

      const { yXmlFragmentToProseMirrorRootNode: toRootNode } = await import('@tiptap/y-tiptap');
      const aMd = mdManager.serialize(toRootNode(clientA.fragment, schema).toJSON());
      const bMd = mdManager.serialize(toRootNode(clientB.fragment, schema).toJSON());
      expect(aMd).toContain('AAA from A');
      expect(aMd).toContain('BBB from B');
      expect(bMd).toContain('AAA from A');
      expect(bMd).toContain('BBB from B');

      await agentWriteMd(server.port, 'reconcile marker\n', { docName, position: 'append' });
      await wait(800);

      assertBridgeInvariant(clientA.ytext, clientA.fragment);
      assertBridgeInvariant(clientB.ytext, clientB.fragment);
    } finally {
      await clientA.cleanup();
      await clientB.cleanup();
    }
  });
});
