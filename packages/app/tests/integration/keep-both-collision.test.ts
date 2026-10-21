import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMetrics } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import {
  agentWriteMd,
  type CreateTestServerOptions,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

let server: TestServer | undefined;
let client: TestClient | undefined;

afterEach(async () => {
  await client?.cleanup();
  client = undefined;
  await server?.cleanup();
  server = undefined;
});

interface HistoryVersion {
  side: string;
  content: string;
}

function liveText(s: TestServer, docName: string): string {
  return s.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
}

async function openWithUnsavedEdit(
  docName: string,
  saved: string,
  edit: { find: string; replace: string },
  mergeHistoryWriter?: CreateTestServerOptions['mergeHistoryWriter'],
): Promise<{ s: TestServer; c: TestClient; file: string }> {
  const s = await createTestServer({
    gitEnabled: true,
    watcherBackend: createWatcherDouble().backend,
    debounce: 300_000,
    maxDebounce: 600_000,
    mergeHistoryWriter,
  });
  server = s;
  const file = join(s.contentDir, `${docName}.md`);
  await agentWriteMd(s.port, saved, { docName, position: 'replace' });
  await pollUntil(
    () => existsSync(file) && readFileSync(file, 'utf-8') === saved,
    10_000,
    25,
    'the seeded document to reach disk',
  );
  const c = await createTestClient(s.port, docName);
  client = c;
  await pollUntil(() => c.ytext.toString() === saved);
  c.doc.transact(() => {
    const at = c.ytext.toString().indexOf(edit.find);
    c.ytext.delete(at, edit.find.length);
    c.ytext.insert(at, edit.replace);
  });
  await pollUntil(() => liveText(s, docName).includes(edit.replace));
  return { s, c, file };
}

async function flushPendingStore(s: TestServer, docName: string): Promise<void> {
  const id = `onStoreDocument-${docName}`;
  if (s.instance.hocuspocus.debouncer.isDebounced(id)) {
    await s.instance.hocuspocus.debouncer.executeNow(id);
  }
}

async function historyVersions(
  s: TestServer,
  docName: string,
  kind: string,
  count: number,
): Promise<HistoryVersion[]> {
  let rows: Array<{ sha: string; checkpoint?: { kind?: string; metadata?: { side?: string } } }> =
    [];
  await pollUntil(
    async () => {
      const res = await fetch(
        `http://127.0.0.1:${s.port}/api/history?docName=${encodeURIComponent(docName)}&limit=100`,
      );
      const body = (await res.json()) as { entries?: typeof rows };
      rows = (body.entries ?? []).filter((entry) => entry.checkpoint?.kind === kind);
      return rows.length >= count;
    },
    10_000,
    50,
    `${count} ${kind} history entries`,
  );
  const versions: HistoryVersion[] = [];
  for (const row of rows) {
    const res = await fetch(
      `http://127.0.0.1:${s.port}/api/history/${row.sha}?docName=${encodeURIComponent(docName)}`,
    );
    const body = (await res.json()) as { content: string };
    versions.push({ side: row.checkpoint?.metadata?.side ?? '', content: body.content });
  }
  return versions.sort((a, b) => a.side.localeCompare(b.side));
}

const SAVED = '# Doc\n\nShared paragraph.\n\nTail.\n';
const EDITED_HERE = '# Doc\n\nShared paragraph, edited here.\n\nTail.\n';
const EDITED_OUTSIDE = '# Doc\n\nShared paragraph, edited outside.\n\nTail.\n';
const BOTH_KEPT =
  '# Doc\n\nShared paragraph, edited here.\n\nShared paragraph, edited outside.\n\nTail.\n';
const PARAGRAPH_EDIT = { find: 'Shared paragraph.', replace: 'Shared paragraph, edited here.' };

const CHECK_SAVED = '# Doc\n\nA\n\nB\n\nC\n';
const CHECK_HERE = '# Doc\n\nA\n\nX\n\nB edited\n\nC\n';
const CHECK_OUTSIDE = '# Doc\n\nA\n\nX\n\nB\n\nC\n';
const CHECK_EDIT = { find: 'B\n\nC', replace: 'X\n\nB edited\n\nC' };

describe('an outside edit to the block being edited here keeps both versions', () => {
  test('the watcher lands both versions live and on disk, raises nothing, and keeps both originals in history', async () => {
    const docName = `keep-both-${randomUUID()}`;
    const { s, c, file } = await openWithUnsavedEdit(docName, SAVED, PARAGRAPH_EDIT);
    const conflictsBefore = getMetrics().conflictCount;

    writeFileSync(file, EDITED_OUTSIDE);
    expect((await s.instance.recheckDisk()).dispatched).toBeGreaterThanOrEqual(1);

    await pollUntil(() => liveText(s, docName) === BOTH_KEPT, 10_000, 25, 'both versions live');
    await pollUntil(
      () => c.ytext.toString() === BOTH_KEPT,
      5_000,
      25,
      'both versions on the client',
    );
    await flushPendingStore(s, docName);
    await pollUntil(() => readFileSync(file, 'utf-8') === BOTH_KEPT, 5_000, 25, 'both on disk');

    expect(s.instance.conflicts.list()).toEqual([]);
    expect(getMetrics().conflictCount).toBe(conflictsBefore);
    expect(await historyVersions(s, docName, 'external-change-both-kept', 2)).toEqual([
      { side: 'ours', content: EDITED_HERE },
      { side: 'theirs', content: EDITED_OUTSIDE },
    ]);
  }, 60_000);

  test('a merge that fails the fidelity check keeps the version here and moves the outside version to history', async () => {
    const docName = `keep-live-${randomUUID()}`;
    const { s, file } = await openWithUnsavedEdit(docName, CHECK_SAVED, CHECK_EDIT);
    const keptLiveBefore = getMetrics().reconcileKeptLive;

    writeFileSync(file, CHECK_OUTSIDE);
    await s.instance.recheckDisk();
    await pollUntil(
      () => getMetrics().reconcileKeptLive > keptLiveBefore,
      10_000,
      25,
      'the keep-live path to run',
    );
    await flushPendingStore(s, docName);
    await pollUntil(() => readFileSync(file, 'utf-8') === CHECK_HERE, 5_000, 25, 'live on disk');

    expect(liveText(s, docName)).toBe(CHECK_HERE);
    expect(s.instance.conflicts.list()).toEqual([]);
    expect(await historyVersions(s, docName, 'external-change-kept-live', 1)).toEqual([
      { side: 'theirs', content: CHECK_OUTSIDE },
    ]);
  }, 60_000);
});

describe('an agent write over an outside edit to the block being edited here', () => {
  test('lands on both versions and answers both-kept, saved, with re-read as the next step', async () => {
    const docName = `agent-keep-both-${randomUUID()}`;
    const { s, file } = await openWithUnsavedEdit(docName, SAVED, PARAGRAPH_EDIT);
    writeFileSync(file, EDITED_OUTSIDE);

    const res = await fetch(`http://127.0.0.1:${s.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: 'Agent line.\n', position: 'append' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      type?: string;
      title?: string;
      detail?: string;
      outcome?: string;
      saved?: boolean;
      nextStep?: string;
      warnings?: Array<{ kind?: string; mergeOutcome?: string }>;
    };
    expect(body).toMatchObject({
      type: 'urn:ok:error:both-kept',
      outcome: 'both-kept',
      saved: true,
      nextStep: 're-read',
    });
    expect(body.detail).toContain('do not retry it');
    expect(readFileSync(file, 'utf-8')).toContain('Agent line.');
    expect(body.warnings?.find((w) => w.kind === 'disk-edit-reconciled')).toMatchObject({
      mergeOutcome: 'both-kept',
    });

    const live = liveText(s, docName);
    expect(live.startsWith(BOTH_KEPT.trimEnd())).toBe(true);
    expect(live).toContain('Agent line.');
    await pollUntil(() => readFileSync(file, 'utf-8') === liveText(s, docName), 5_000, 25, 'disk');
    expect(s.instance.conflicts.list()).toEqual([]);
    expect(await historyVersions(s, docName, 'external-change-both-kept', 2)).toEqual([
      { side: 'ours', content: EDITED_HERE },
      { side: 'theirs', content: EDITED_OUTSIDE },
    ]);
  }, 60_000);

  test('a merge that fails the fidelity check lands the write on the version here and answers merged-first', async () => {
    const docName = `agent-keep-live-${randomUUID()}`;
    const { s, file } = await openWithUnsavedEdit(docName, CHECK_SAVED, CHECK_EDIT);
    writeFileSync(file, CHECK_OUTSIDE);

    const res = await fetch(`http://127.0.0.1:${s.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: 'Agent line.\n', position: 'append' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome?: string;
      saved?: boolean;
      nextStep?: string;
      warnings?: Array<{ kind?: string; mergeOutcome?: string }>;
    };
    expect(body).toMatchObject({ outcome: 'merged-first', saved: true, nextStep: 're-read' });
    expect(body.warnings?.find((w) => w.kind === 'disk-edit-reconciled')).toMatchObject({
      mergeOutcome: 'kept-live',
    });

    const live = liveText(s, docName);
    expect(live.startsWith(CHECK_HERE.trimEnd())).toBe(true);
    expect(live).toContain('Agent line.');
    await pollUntil(() => readFileSync(file, 'utf-8') === liveText(s, docName), 5_000, 25, 'disk');
    expect(s.instance.conflicts.list()).toEqual([]);
    expect(await historyVersions(s, docName, 'external-change-kept-live', 1)).toEqual([
      { side: 'theirs', content: CHECK_OUTSIDE },
    ]);
  }, 60_000);
});

const failingHistoryWriter = () =>
  vi.fn<NonNullable<CreateTestServerOptions['mergeHistoryWriter']>>(() =>
    Promise.reject(new Error('injected history write failure')),
  );

describe('when the history write fails', () => {
  test('a merge that fails the fidelity check raises the reconcile conflict and leaves the outside bytes on disk', async () => {
    const docName = `keep-live-no-history-${randomUUID()}`;
    const writer = failingHistoryWriter();
    const { s, file } = await openWithUnsavedEdit(docName, CHECK_SAVED, CHECK_EDIT, writer);
    const failuresBefore = getMetrics().mergeHistoryCheckpointFailures;

    writeFileSync(file, CHECK_OUTSIDE);
    await s.instance.recheckDisk();
    await pollUntil(
      () => s.instance.conflicts.findByDocName(docName) !== undefined,
      10_000,
      25,
      'the reconcile conflict',
    );
    await flushPendingStore(s, docName);

    expect(s.instance.conflicts.findByDocName(docName)).toMatchObject({
      kind: 'reconcile',
      reason: 'refused-too-large',
    });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(getMetrics().mergeHistoryCheckpointFailures).toBe(failuresBefore + 1);
    expect(liveText(s, docName)).toBe(CHECK_HERE);
    expect(readFileSync(file, 'utf-8')).toBe(CHECK_OUTSIDE);
  }, 60_000);

  test('an agent write over a merge that fails the fidelity check is refused and the outside bytes stay on disk', async () => {
    const docName = `agent-keep-live-no-history-${randomUUID()}`;
    const writer = failingHistoryWriter();
    const { s, file } = await openWithUnsavedEdit(docName, CHECK_SAVED, CHECK_EDIT, writer);
    writeFileSync(file, CHECK_OUTSIDE);

    const res = await fetch(`http://127.0.0.1:${s.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: 'Agent line.\n', position: 'append' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:doc-in-conflict');
    expect(writer).toHaveBeenCalledTimes(1);
    expect(s.instance.conflicts.findByDocName(docName)).toMatchObject({
      kind: 'reconcile',
      reason: 'refused-too-large',
    });
    expect(liveText(s, docName)).not.toContain('Agent line.');
    expect(readFileSync(file, 'utf-8')).toBe(CHECK_OUTSIDE);
  }, 60_000);

  test('a same-block collision still keeps both versions, counting the failed history writes', async () => {
    const docName = `keep-both-no-history-${randomUUID()}`;
    const writer = failingHistoryWriter();
    const { s, file } = await openWithUnsavedEdit(docName, SAVED, PARAGRAPH_EDIT, writer);
    const failuresBefore = getMetrics().mergeHistoryCheckpointFailures;

    writeFileSync(file, EDITED_OUTSIDE);
    await s.instance.recheckDisk();
    await pollUntil(() => liveText(s, docName) === BOTH_KEPT, 10_000, 25, 'both versions live');
    await flushPendingStore(s, docName);
    await pollUntil(() => readFileSync(file, 'utf-8') === BOTH_KEPT, 5_000, 25, 'both on disk');
    await pollUntil(
      () => getMetrics().mergeHistoryCheckpointFailures === failuresBefore + 2,
      5_000,
      25,
      'both injected history writes to fail',
    );

    expect(s.instance.conflicts.list()).toEqual([]);
    const attempted = writer.mock.calls.map(([, , params]) =>
      params.kind === 'external-change-both-kept'
        ? `${params.kind}:${params.metadata.side}:${params.metadata.keptBlocks}`
        : params.kind,
    );
    expect(attempted.sort()).toEqual([
      'external-change-both-kept:ours:1',
      'external-change-both-kept:theirs:1',
    ]);
  }, 60_000);
});
