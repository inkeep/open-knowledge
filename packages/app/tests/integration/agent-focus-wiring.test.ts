import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentPatch,
  agentUndo,
  agentWriteMd,
  awaitBacklinkIndexed,
  awaitFileWatcherIndexed,
  createTestServer,
  type TestServer,
} from './test-harness';

async function seedDoc(contentDir: string, docName: string, body: string): Promise<void> {
  const filePath = join(contentDir, `${docName}.md`);
  mkdirSync(dirname(filePath), { recursive: true });
  await wait(100);
  writeFileSync(filePath, body, 'utf-8');
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('agent-focus wiring — L1 integration', () => {
  test('POST /api/agent-write-md publishes focus with writeKind=write', async () => {
    const docName = `focus-write-${crypto.randomUUID().slice(0, 8)}`;
    const before = Date.now();

    await agentWriteMd(server.port, '# test', { docName, position: 'replace' });

    const focusMap = server.instance.agentFocusBroadcaster.getFocusMap();
    expect(focusMap['claude-1']).toBeDefined();
    expect(focusMap['claude-1'].agentName).toBe('Claude');
    expect(focusMap['claude-1'].currentDoc).toBe(docName);
    expect(focusMap['claude-1'].writeKind).toBe('write');
    expect(focusMap['claude-1'].ts).toBeGreaterThanOrEqual(before);
    expect(focusMap['claude-1'].ts).toBeLessThanOrEqual(Date.now());
  });

  test('POST /api/agent-patch publishes focus with writeKind=edit', async () => {
    const docName = `focus-patch-${crypto.randomUUID().slice(0, 8)}`;
    await agentWriteMd(server.port, 'hello world', { docName, position: 'replace' as const });
    await wait(50);

    const res = await agentPatch(server.port, 'world', 'there', docName);
    expect(res.ok).toBe(true);

    const focusMap = server.instance.agentFocusBroadcaster.getFocusMap();
    expect(focusMap['claude-1'].currentDoc).toBe(docName);
    expect(focusMap['claude-1'].writeKind).toBe('edit');
  });

  test('POST /api/agent-undo publishes focus with writeKind=undo (US-025, D43)', async () => {
    const docName = `focus-undo-${crypto.randomUUID().slice(0, 8)}`;
    const rawId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const connectionId = `agent-${rawId}`;

    await agentWriteMd(server.port, '# original', { docName, position: 'replace', agentId: rawId });
    await wait(50);

    await agentUndo(server.port, { docName, connectionId });

    const focusMap = server.instance.agentFocusBroadcaster.getFocusMap();
    expect(focusMap[connectionId]).toBeDefined();
    expect(focusMap[connectionId].currentDoc).toBe(docName);
    expect(focusMap[connectionId].writeKind).toBe('undo');
  });

  test('successive writes advance ts — latest-wins ready', async () => {
    const docA = `focus-a-${crypto.randomUUID().slice(0, 8)}`;
    const docB = `focus-b-${crypto.randomUUID().slice(0, 8)}`;

    await agentWriteMd(server.port, '# a', { docName: docA, position: 'replace' });
    const tsA = server.instance.agentFocusBroadcaster.getFocusMap()['claude-1'].ts;

    await wait(20);
    await agentWriteMd(server.port, '# b', { docName: docB, position: 'replace' });
    const entryB = server.instance.agentFocusBroadcaster.getFocusMap()['claude-1'];

    expect(entryB.currentDoc).toBe(docB);
    expect(entryB.ts).toBeGreaterThan(tsA);
  });
});

describe('orphan-hint response shape — L1 integration (US-003)', () => {
  async function postWrite(
    docName: string,
    body: string,
  ): Promise<{
    timestamp: string;
    hints?: Array<{ type: string; parentCandidates: string[]; message: string }>;
  }> {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: body, position: 'replace', docName }),
    });
    return res.json() as Promise<{
      timestamp: string;
      hints?: Array<{ type: string; parentCandidates: string[]; message: string }>;
    }>;
  }

  const ORPHAN_HINT_TEST_TIMEOUT_MS = 45_000;

  test(
    'orphan doc in folder with a hub gets a hint',
    async () => {
      const folder = `orph-${crypto.randomUUID().slice(0, 8)}`;
      await seedDoc(server.contentDir, `${folder}/README`, '# README\n\nHub of the folder.\n');
      await awaitFileWatcherIndexed(server, `${folder}/README`);

      const orphanName = `${folder}/orphan`;
      const body = await postWrite(orphanName, '# Orphan body without any wiki-links');
      expect(body.timestamp).toBeDefined();
      expect(body.hints).toBeDefined();
      expect(body.hints?.length).toBe(1);
      expect(body.hints?.[0].type).toBe('orphan');
      expect(body.hints?.[0].parentCandidates).toContain(`${folder}/README`);
      expect(body.hints?.[0].message).toContain('[[');
    },
    ORPHAN_HINT_TEST_TIMEOUT_MS,
  );

  test(
    'doc with an existing backlink gets no hint',
    async () => {
      const folder = `bl-${crypto.randomUUID().slice(0, 8)}`;
      const target = `${folder}/linked`;
      await seedDoc(server.contentDir, `${folder}/README`, `# README\n\nSee [[${target}]].\n`);
      await seedDoc(server.contentDir, target, '# Linked\n\nBody.\n');
      await awaitBacklinkIndexed(server, target, `${folder}/README`);

      const body = await postWrite(target, '# Linked body v2');
      expect(body.timestamp).toBeDefined();
      expect(body.hints).toBeUndefined();
    },
    ORPHAN_HINT_TEST_TIMEOUT_MS,
  );

  test('orphan in folder without a hub gets no hint', async () => {
    const folder = `nohub-${crypto.randomUUID().slice(0, 8)}`;
    const orphanName = `${folder}/solo`;
    const body = await postWrite(orphanName, '# Solo body');
    expect(body.timestamp).toBeDefined();
    expect(body.hints).toBeUndefined();
  });
});

describe('systemSubscriberCount response field — L1 integration (FR7a)', () => {
  async function postWriteRaw(
    docName: string,
    body: string,
  ): Promise<{
    timestamp: string;
    subscriberCount?: number;
    systemSubscriberCount?: number;
  }> {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: body, position: 'replace', docName }),
    });
    return res.json() as Promise<{
      timestamp: string;
      subscriberCount?: number;
      systemSubscriberCount?: number;
    }>;
  }

  test('response includes systemSubscriberCount alongside subscriberCount', async () => {
    const docName = `ssc-${crypto.randomUUID().slice(0, 8)}`;
    const body = await postWriteRaw(docName, '# hello');
    expect(body.timestamp).toBeDefined();
    expect(typeof body.subscriberCount).toBe('number');
    expect(typeof body.systemSubscriberCount).toBe('number');
  });

  test('systemSubscriberCount is 0 when no editor is attached to __system__', async () => {
    const docName = `ssc-cold-${crypto.randomUUID().slice(0, 8)}`;
    const body = await postWriteRaw(docName, '# hello');
    expect(body.timestamp).toBeDefined();
    expect(body.systemSubscriberCount).toBe(0);
  });
});
