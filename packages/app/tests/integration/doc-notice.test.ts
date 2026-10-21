import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { getMetrics } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import { dismissDocNotice, fetchDocNotices } from '../../src/hooks/use-doc-notices';
import { dispatchCC1Stateless, SYSTEM_DOC_NAME } from '../../src/lib/cc1';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

const cleanups: Array<() => Promise<void> | void> = [];
const realFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function liveText(s: TestServer, docName: string): string {
  return s.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
}

function edit(c: TestClient, find: string, replace: string): void {
  c.doc.transact(() => {
    const at = c.ytext.toString().indexOf(find);
    c.ytext.delete(at, find.length);
    c.ytext.insert(at, replace);
  });
}

async function serverWithOpenDoc(docName: string, saved: string) {
  const s = await createTestServer({
    gitEnabled: true,
    watcherBackend: createWatcherDouble().backend,
    debounce: 300_000,
    maxDebounce: 600_000,
  });
  cleanups.push(() => s.cleanup());
  globalThis.fetch = (input, init) =>
    realFetch(
      typeof input === 'string' && input.startsWith('/')
        ? `http://127.0.0.1:${s.port}${input}`
        : input,
      init,
    );
  const file = join(s.contentDir, `${docName}.md`);
  await agentWriteMd(s.port, saved, { docName, position: 'replace' });
  await pollUntil(
    () => existsSync(file) && readFileSync(file, 'utf-8') === saved,
    10_000,
    25,
    'the seeded document to reach disk',
  );
  const c = await createTestClient(s.port, docName);
  cleanups.push(() => c.cleanup());
  await pollUntil(() => c.ytext.toString() === saved);
  return { s, c, file };
}

function watchSyncStatus(port: number): { count: () => number } {
  const doc = new Y.Doc();
  let signals = 0;
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: SYSTEM_DOC_NAME,
    document: doc,
    onStateless: ({ payload }) => {
      dispatchCC1Stateless(payload, {
        onDerivedView: (signal) => {
          if (signal.ch === 'sync-status') signals++;
        },
      });
    },
  });
  cleanups.push(() => {
    provider.destroy();
    doc.destroy();
  });
  return { count: () => signals };
}

async function noticesFor(docName: string) {
  const notices = await fetchDocNotices();
  if (notices === null) throw new Error('the app could not read the notices');
  return notices.filter((notice) => notice.docName === docName);
}

async function checkpointShas(s: TestServer, docName: string, kind: string): Promise<string[]> {
  const res = await realFetch(
    `http://127.0.0.1:${s.port}/api/history?docName=${encodeURIComponent(docName)}&limit=100`,
  );
  const body = (await res.json()) as {
    entries?: Array<{ sha: string; checkpoint?: { kind?: string } }>;
  };
  return (body.entries ?? [])
    .filter((entry) => entry.checkpoint?.kind === kind)
    .map((entry) => entry.sha);
}

const SAVED = '# Doc\n\nShared paragraph.\n\nTail.\n';

describe('the notice on a document after an outside edit', () => {
  test('a both-kept merge reaches the app as one notice pointing at both history entries; a second collision updates it and dismissal clears it', async () => {
    const docName = `notice-both-${randomUUID()}`;
    const { s, c, file } = await serverWithOpenDoc(docName, SAVED);
    const syncStatus = watchSyncStatus(s.port);
    edit(c, 'Shared paragraph.', 'Shared paragraph, edited here.');
    await pollUntil(() => liveText(s, docName).includes('edited here'));
    expect(await noticesFor(docName)).toEqual([]);
    const signalsBefore = syncStatus.count();

    writeFileSync(file, '# Doc\n\nShared paragraph, edited outside.\n\nTail.\n');
    await s.instance.recheckDisk();
    await pollUntil(() => liveText(s, docName).includes('edited outside'), 10_000, 25, 'both kept');
    await pollUntil(() => syncStatus.count() > signalsBefore, 10_000, 25, 'a sync-status signal');

    let shas: string[] = [];
    await pollUntil(
      async () => {
        shas = await checkpointShas(s, docName, 'external-change-both-kept');
        const [notice] = await noticesFor(docName);
        return shas.length === 2 && notice?.entries.length === 2;
      },
      10_000,
      50,
      'the notice to point at both history entries',
    );
    const [first] = await noticesFor(docName);
    expect(first).toMatchObject({
      kind: 'both-kept',
      kept: { duplicated: 1, restoredDeletedHere: 0, restoredDeletedOutside: 0 },
      events: 1,
    });
    expect([...(first?.entries ?? [])].sort()).toEqual([...shas].sort());

    edit(c, 'Tail.', 'Tail, edited here.');
    await pollUntil(() => liveText(s, docName).includes('Tail, edited here.'));
    writeFileSync(file, '# Doc\n\nShared paragraph, edited outside.\n\nTail, edited outside.\n');
    await s.instance.recheckDisk();
    await pollUntil(
      async () => (await noticesFor(docName))[0]?.events === 2,
      10_000,
      50,
      'the second collision to update the notice',
    );
    const updated = await noticesFor(docName);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.id).toBe(first?.id);

    const signalsBeforeDismiss = syncStatus.count();
    expect(await dismissDocNotice(docName, first?.id ?? '')).toBe(true);
    expect(await noticesFor(docName)).toEqual([]);
    await pollUntil(() => syncStatus.count() > signalsBeforeDismiss, 10_000, 25, 'a signal');
    const stored = readFileSync(join(s.contentDir, '.ok', 'local', 'doc-notices.json'), 'utf-8');
    expect(stored).not.toContain(docName);
  }, 60_000);

  test('an outside edit that fails the merge check reaches the app as a notice that the outside version is in history', async () => {
    const docName = `notice-moved-${randomUUID()}`;
    const { s, c, file } = await serverWithOpenDoc(docName, '# Doc\n\nA\n\nB\n\nC\n');
    edit(c, 'B\n\nC', 'X\n\nB edited\n\nC');
    await pollUntil(() => liveText(s, docName).includes('B edited'));
    const keptLiveBefore = getMetrics().reconcileKeptLive;

    writeFileSync(file, '# Doc\n\nA\n\nX\n\nB\n\nC\n');
    await s.instance.recheckDisk();
    await pollUntil(() => getMetrics().reconcileKeptLive > keptLiveBefore, 10_000, 25, 'kept live');

    const shas = await checkpointShas(s, docName, 'external-change-kept-live');
    expect(shas).toHaveLength(1);
    expect(await noticesFor(docName)).toEqual([
      expect.objectContaining({
        kind: 'moved-to-history',
        side: 'theirs',
        reason: 'check-failed',
        entries: shas,
      }),
    ]);
  }, 60_000);

  test('an agent write that lands on both kept versions raises the same notice', async () => {
    const docName = `notice-agent-${randomUUID()}`;
    const { s, c, file } = await serverWithOpenDoc(docName, SAVED);
    edit(c, 'Shared paragraph.', 'Shared paragraph, edited here.');
    await pollUntil(() => liveText(s, docName).includes('edited here'));
    writeFileSync(file, '# Doc\n\nShared paragraph, edited outside.\n\nTail.\n');

    const res = await realFetch(`http://127.0.0.1:${s.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: 'Agent line.\n', position: 'append' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      type: 'urn:ok:error:both-kept',
      outcome: 'both-kept',
      saved: true,
      nextStep: 're-read',
    });

    expect(await noticesFor(docName)).toEqual([
      expect.objectContaining({
        kind: 'both-kept',
        kept: expect.objectContaining({ duplicated: 1 }),
      }),
    ]);
  }, 60_000);
});
