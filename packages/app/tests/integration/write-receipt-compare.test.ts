import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import { applyAgentMarkdownWrite } from '../../../server/src/agent-sessions';
import { DerivedDocumentIndex } from '../../../server/src/derived-document-index';
import * as diskContentIntake from '../../../server/src/disk-content-intake';
import { _resetDocExtensionsForTests } from '../../../server/src/doc-extensions';
import * as fsTraced from '../../../server/src/fs-traced';
import { getMetrics } from '../../../server/src/metrics';
import { contentHash } from '../../../server/src/version-hash';
import { createManualClock } from '../../../server/src/watcher-clock.test-helper';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import {
  createTestClient,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

const SEED = '# Doc\n\nfirst paragraph\n\nsecond paragraph\n';

let server: TestServer | undefined;
let client: TestClient | undefined;
const ownedDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.OK_TEST_COMPARE_READ_FAULT;
  delete process.env.OK_TEST_STORE_RESTAT_RACE;
  delete process.env.OK_TEST_STORE_FAULT;
  await client?.cleanup();
  client = undefined;
  await server?.cleanup();
  server = undefined;
  for (const dir of ownedDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function compareCount(outcome: string): number {
  return (getMetrics().storeDiskCompare as Record<string, number | undefined>)[outcome] ?? 0;
}

async function startWithDoc(
  options: Parameters<typeof createTestServer>[0] = {},
): Promise<{ server: TestServer; docName: string; file: string }> {
  const started = await createTestServer({
    watcherBackend: createWatcherDouble().backend,
    debounce: 50,
    maxDebounce: 200,
    ...options,
  });
  server = started;
  const docName = `receipt-${randomUUID()}`;
  const file = join(started.contentDir, `${docName}.md`);
  writeFileSync(file, SEED);
  return { server: started, docName, file };
}

async function openClient(
  port: number,
  docName: string,
  options?: Parameters<typeof createTestClient>[2],
): Promise<TestClient> {
  client = await createTestClient(port, docName, options);
  const opened = client;
  await pollUntil(() => opened.ytext.toString() === SEED, 5_000, 25, 'the seeded document');
  return opened;
}

function typeAfter(doc: Y.Doc, text: Y.Text, anchor: string, insertion: string): void {
  const at = text.toString().indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${anchor}`);
  doc.transact(() => text.insert(at + anchor.length, insertion));
}

function serverText(target: TestServer, docName: string): string | undefined {
  return target.instance.hocuspocus.documents.get(docName)?.getText('source').toString();
}

async function expectDiskAndLiveToSettleOn(
  target: TestServer,
  docName: string,
  file: string,
  expected: string,
): Promise<void> {
  await pollUntil(
    () => readFileSync(file, 'utf-8') === expected,
    8_000,
    25,
    'the merged bytes on disk',
  );
  await pollUntil(() => serverText(target, docName) === expected, 5_000, 25, 'the live text');
  expect(target.instance.durabilityState.getReceipt(docName)?.hash).toBe(contentHash(expected));
}

describe('compare before every Markdown write', () => {
  test('a person save over an outside edit in another block merges both, byte for byte', async () => {
    const { server: s, docName, file } = await startWithDoc();
    const c = await openClient(s.port, docName);
    const changedBefore = compareCount('changed');

    writeFileSync(file, '# Doc\n\nfirst paragraph changed outside\n\nsecond paragraph\n');
    typeAfter(c.doc, c.ytext, 'second paragraph', ' typed here');

    await expectDiskAndLiveToSettleOn(
      s,
      docName,
      file,
      '# Doc\n\nfirst paragraph changed outside\n\nsecond paragraph typed here\n',
    );
    expect(compareCount('changed')).toBeGreaterThan(changedBefore);
  });

  test('an outside change the bridge normalizer would tolerate is kept, not written over', async () => {
    const { server: s, docName, file } = await startWithDoc();
    const c = await openClient(s.port, docName);

    writeFileSync(file, '# Doc\n\nfirst paragraph   \n\nsecond paragraph\n');
    typeAfter(c.doc, c.ytext, 'second paragraph', ' typed here');

    await expectDiskAndLiveToSettleOn(
      s,
      docName,
      file,
      '# Doc\n\nfirst paragraph   \n\nsecond paragraph typed here\n',
    );
  });

  test('an agent store over an outside change its pre-write merge skipped merges it first', async () => {
    const { server: s, docName, file } = await startWithDoc();
    await openClient(s.port, docName);

    writeFileSync(file, '# Doc\n\nfirst paragraph   \n\nsecond paragraph\n');
    const response = await fetch(`http://127.0.0.1:${s.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: '\nagent line\n', position: 'append' }),
    });
    expect(response.status).toBe(200);

    await expectDiskAndLiveToSettleOn(
      s,
      docName,
      file,
      '# Doc\n\nfirst paragraph   \n\nsecond paragraph\n\nagent line\n',
    );
  });

  test('the staleness watchdog forces a store that merges an outside edit instead of standing down', async () => {
    const {
      server: s,
      docName,
      file,
    } = await startWithDoc({
      stalenessGraceMs: 250,
      stalenessSweepIntervalMs: 100,
    });
    await openClient(s.port, docName);
    const forcedBefore = getMetrics().persistenceStalenessForcedStores;

    process.env.OK_TEST_STORE_FAULT = docName;
    const failed = await fetch(`http://127.0.0.1:${s.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: '\nagent line\n', position: 'append' }),
    });
    expect(failed.status).toBe(507);
    delete process.env.OK_TEST_STORE_FAULT;
    writeFileSync(file, '# Doc\n\nfirst paragraph changed outside\n\nsecond paragraph\n');

    await expectDiskAndLiveToSettleOn(
      s,
      docName,
      file,
      '# Doc\n\nfirst paragraph changed outside\n\nsecond paragraph\n\nagent line\n',
    );
    expect(getMetrics().persistenceStalenessForcedStores).toBeGreaterThan(forcedBefore);
  });

  test('a whole-document agent replace saved by the ordinary store merges an outside edit', async () => {
    const { server: s, docName, file } = await startWithDoc();
    const session = await s.instance.sessionManager.getSession(docName, 'acp-replace', {
      displayName: 'ACP agent',
      colorSeed: 'acp-replace',
      clientName: 'acp',
    });
    await pollUntil(
      () => serverText(s, docName) === SEED,
      5_000,
      25,
      'the session to load the document',
    );

    writeFileSync(file, '# Doc\n\nfirst paragraph changed outside\n\nsecond paragraph\n');
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(
        session.dc.document,
        '# Doc\n\nfirst paragraph\n\nsecond paragraph rewritten by the agent\n',
        'replace',
      );
    }, session.origin);

    await expectDiskAndLiveToSettleOn(
      s,
      docName,
      file,
      '# Doc\n\nfirst paragraph changed outside\n\nsecond paragraph rewritten by the agent\n',
    );
  });

  test('the shutdown flush merges an outside edit into the pending save', async () => {
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-receipt-shutdown-')));
    ownedDirs.push(contentDir);
    const {
      server: s,
      docName,
      file,
    } = await startWithDoc({
      contentDir,
      keepContentDir: true,
      debounce: 60_000,
      maxDebounce: 120_000,
    });
    await s.instance.hocuspocus.openDirectConnection(docName);
    const live = s.instance.hocuspocus.documents.get(docName);
    if (!live) throw new Error('document not loaded');
    await pollUntil(() => live.getText('source').toString() === SEED, 5_000, 25, 'the load');

    typeAfter(live, live.getText('source'), 'second paragraph', ' typed here');
    writeFileSync(file, '# Doc\n\nfirst paragraph changed outside\n\nsecond paragraph\n');
    expect(readFileSync(file, 'utf-8')).not.toContain('typed here');

    await s.cleanup();
    server = undefined;

    expect(readFileSync(file, 'utf-8')).toBe(
      '# Doc\n\nfirst paragraph changed outside\n\nsecond paragraph typed here\n',
    );
  });

  test('a change made while the server was stopped is found at load from the persisted receipt', async () => {
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-receipt-restart-')));
    ownedDirs.push(contentDir);
    const first = await startWithDoc({ contentDir, keepContentDir: true });
    const c = await openClient(first.server.port, first.docName, { resetOnCleanup: false });
    typeAfter(c.doc, c.ytext, 'second paragraph', ' saved before quitting');
    const saved = '# Doc\n\nfirst paragraph\n\nsecond paragraph saved before quitting\n';
    await pollUntil(() => readFileSync(first.file, 'utf-8') === saved, 8_000, 25, 'the save');
    await c.cleanup();
    client = undefined;
    await first.server.cleanup();
    server = undefined;

    const receiptLog = readFileSync(join(contentDir, '.ok', 'local', 'receipts.jsonl'), 'utf-8');
    expect(receiptLog).toContain(contentHash(saved));

    const editedWhileStopped =
      '# Doc\n\nfirst paragraph edited while stopped\n\nsecond paragraph saved before quitting\n';
    writeFileSync(first.file, editedWhileStopped);
    const changedAtLoadBefore = getMetrics().receiptAtLoad.changed ?? 0;
    const mergesBefore = compareCount('changed');

    server = await createTestServer({
      contentDir,
      keepContentDir: true,
      watcherBackend: createWatcherDouble().backend,
      debounce: 50,
      maxDebounce: 200,
    });
    client = await createTestClient(server.port, first.docName);
    const reopened = client;
    await pollUntil(
      () => reopened.ytext.toString() === editedWhileStopped,
      5_000,
      25,
      'the disk version at load',
    );
    expect(getMetrics().receiptAtLoad.changed ?? 0).toBe(changedAtLoadBefore + 1);
    expect(server.instance.durabilityState.getReconciledBase(first.docName)).toBe(
      editedWhileStopped,
    );

    typeAfter(reopened.doc, reopened.ytext, 'saved before quitting', ' and after');
    const final =
      '# Doc\n\nfirst paragraph edited while stopped\n\nsecond paragraph saved before quitting and after\n';
    await expectDiskAndLiveToSettleOn(server, first.docName, first.file, final);
    expect(compareCount('changed')).toBe(mergesBefore);
  });

  test('an .mdx receipt survives a cold restart, counts a change made while stopped and recognises a late echo', async () => {
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-receipt-mdx-restart-')));
    ownedDirs.push(contentDir);
    const docName = `receipt-mdx-${randomUUID()}`;
    const file = join(contentDir, `${docName}.mdx`);
    writeFileSync(file, SEED);
    server = await createTestServer({
      contentDir,
      keepContentDir: true,
      watcherBackend: createWatcherDouble().backend,
      debounce: 50,
      maxDebounce: 200,
    });
    const first = await openClient(server.port, docName, { resetOnCleanup: false });
    typeAfter(first.doc, first.ytext, 'second paragraph', ' saved before quitting');
    const saved = '# Doc\n\nfirst paragraph\n\nsecond paragraph saved before quitting\n';
    await pollUntil(() => readFileSync(file, 'utf-8') === saved, 8_000, 25, 'the save');
    await first.cleanup();
    client = undefined;
    await server.cleanup();
    server = undefined;

    const edited =
      '# Doc\n\nfirst paragraph edited while stopped\n\nsecond paragraph saved before quitting\n';
    writeFileSync(file, edited);
    _resetDocExtensionsForTests();
    const changedBefore = getMetrics().receiptAtLoad.changed ?? 0;
    const clock = createManualClock(Date.now());
    const double = createWatcherDouble();
    server = await createTestServer({
      contentDir,
      keepContentDir: true,
      watcherBackend: double.backend,
      watcherClock: clock,
      debounce: 50,
      maxDebounce: 200,
    });
    const restarted = server;
    await new Promise((resolve) => setImmediate(resolve));
    client = await createTestClient(restarted.port, docName);
    const reopened = client;
    await pollUntil(() => reopened.ytext.toString() === edited, 5_000, 25, 'the load');
    expect(getMetrics().receiptAtLoad.changed ?? 0).toBe(changedBefore + 1);

    typeAfter(reopened.doc, reopened.ytext, 'quitting', ' and after');
    const final =
      '# Doc\n\nfirst paragraph edited while stopped\n\nsecond paragraph saved before quitting and after\n';
    await pollUntil(
      () => readFileSync(file, 'utf-8') === final,
      8_000,
      25,
      'the save after restart',
    );
    clock.advance(25_000);
    const echoesBefore = getMetrics().receiptIntakeSkip.echo ?? 0;
    double.subscriptionFor(restarted.contentDir).deliver([{ type: 'update', path: file }]);
    await pollUntil(
      () => {
        clock.advance(50);
        return (getMetrics().receiptIntakeSkip.echo ?? 0) > echoesBefore;
      },
      5_000,
      25,
      'the late echo to reach the intake',
    );
    expect(readFileSync(join(contentDir, '.ok', 'local', 'receipts.jsonl'), 'utf-8')).toContain(
      contentHash(final),
    );
  });

  test('a store whose merge of the outside edit fails to apply holds the save and never writes over the outside bytes', async () => {
    const { server: s, docName, file } = await startWithDoc();
    const c = await openClient(s.port, docName);
    const outside = '# Doc\n\nfirst paragraph changed outside\n\nsecond paragraph\n';
    const realApply = diskContentIntake.applyDiskContentToDoc;
    vi.spyOn(diskContentIntake, 'applyDiskContentToDoc').mockImplementation((...args) => {
      if (args[1].includes('changed outside')) throw new Error('injected apply failure');
      return realApply(...args);
    });
    const heldBefore = compareCount('pending-intake-failed');

    writeFileSync(file, outside);
    typeAfter(c.doc, c.ytext, 'second paragraph', ' typed here');

    await pollUntil(
      () => compareCount('pending-intake-failed') > heldBefore,
      8_000,
      25,
      'the held save',
    );
    expect(readFileSync(file, 'utf-8')).toBe(outside);
    expect(serverText(s, docName)).toContain('typed here');
    expect(serverText(s, docName)).not.toContain('changed outside');
    expect(s.instance.durabilityState.getReceipt(docName)?.hash).not.toBe(contentHash(outside));
    expect(s.instance.durabilityState.isStoreRefused(docName)).toBe(true);

    vi.restoreAllMocks();
    typeAfter(c.doc, c.ytext, 'typed here', ' and again');
    await expectDiskAndLiveToSettleOn(
      s,
      docName,
      file,
      '# Doc\n\nfirst paragraph changed outside\n\nsecond paragraph typed here and again\n',
    );
  });

  test('a save with no agreed version whose ingest of the outside file fails is held and leaves no receipt for the outside bytes', async () => {
    const started = await createTestServer({
      watcherBackend: createWatcherDouble().backend,
      debounce: 300_000,
      maxDebounce: 600_000,
    });
    server = started;
    const docName = `receipt-no-base-${randomUUID()}`;
    const file = join(started.contentDir, `${docName}.md`);
    client = await createTestClient(started.port, docName);
    const c = client;
    c.doc.transact(() => c.ytext.insert(0, '# Typed\n\nbefore the file existed\n'));
    await pollUntil(
      () => serverText(started, docName)?.includes('before the file existed') === true,
      5_000,
      25,
      'the typing to reach the server',
    );
    const outside = '# Doc\n\ncreated outside\n';
    writeFileSync(file, outside);
    const realApply = diskContentIntake.applyDiskContentToDoc;
    vi.spyOn(diskContentIntake, 'applyDiskContentToDoc').mockImplementation((...args) => {
      if (args[1].includes('created outside')) throw new Error('injected apply failure');
      return realApply(...args);
    });
    const heldBefore = compareCount('pending-intake-failed-no-base');

    await runPendingStore(started, docName).catch(() => undefined);

    expect(compareCount('pending-intake-failed-no-base')).toBe(heldBefore + 1);
    expect(readFileSync(file, 'utf-8')).toBe(outside);
    expect(started.instance.durabilityState.getReceipt(docName)).toBeUndefined();
    expect(started.instance.durabilityState.getReconciledBase(docName)).toBeUndefined();
    expect(serverText(started, docName)).toContain('before the file existed');

    vi.restoreAllMocks();
    c.doc.transact(() => c.ytext.insert(c.ytext.length, '\nmore typing\n'));
    await pollUntil(
      () => serverText(started, docName)?.includes('more typing') === true,
      5_000,
      25,
      'the second edit to reach the server',
    );
    await runPendingStore(started, docName).catch(() => undefined);
    await pollUntil(() => serverText(started, docName) === outside, 5_000, 25, 'the ingest');
    expect(readFileSync(file, 'utf-8')).toBe(outside);
    expect(started.instance.durabilityState.getReceipt(docName)?.hash).toBe(contentHash(outside));
  });

  test('an outside file the intake raises a conflict for holds the save once as a conflict, not as a file that kept changing', async () => {
    const { server: s, docName, file } = await startWithDoc();
    const c = await openClient(s.port, docName);
    const conflictsBefore = getMetrics().conflictCount;
    const heldBefore = compareCount('pending-conflict');
    const exhaustedBefore = compareCount('pending-exhausted');
    const marked =
      '# Doc\n\n<<<<<<< HEAD\nfirst paragraph\n=======\nfirst paragraph elsewhere\n>>>>>>> other\n\nsecond paragraph\n';

    writeFileSync(file, marked);
    typeAfter(c.doc, c.ytext, 'second paragraph', ' typed here');

    await pollUntil(
      () => compareCount('pending-conflict') > heldBefore,
      8_000,
      25,
      'the held save',
    );
    expect(compareCount('pending-exhausted')).toBe(exhaustedBefore);
    expect(getMetrics().conflictCount).toBe(conflictsBefore + 1);
    expect(s.instance.conflicts.findByDocName(docName)).toBeDefined();
    expect(readFileSync(file, 'utf-8')).toBe(marked);
    expect(serverText(s, docName)).toContain('typed here');
  });

  test('an index failure after the outside edit was taken in does not hold the save', async () => {
    const { server: s, docName, file } = await startWithDoc();
    const c = await openClient(s.port, docName);
    const heldBefore = compareCount('pending-intake-failed');
    const outside = '# Doc\n\nfirst paragraph changed outside\n\nsecond paragraph\n';
    const realUpsert = DerivedDocumentIndex.prototype.recordDiskUpsert;
    vi.spyOn(DerivedDocumentIndex.prototype, 'recordDiskUpsert').mockImplementation(function (
      this: DerivedDocumentIndex,
      documentName,
      markdown,
    ) {
      if (documentName === docName && markdown === outside) {
        return Promise.reject(new Error('injected index failure'));
      }
      return realUpsert.call(this, documentName, markdown);
    });

    writeFileSync(file, outside);
    typeAfter(c.doc, c.ytext, 'second paragraph', ' typed here');

    await expectDiskAndLiveToSettleOn(
      s,
      docName,
      file,
      '# Doc\n\nfirst paragraph changed outside\n\nsecond paragraph typed here\n',
    );
    expect(compareCount('pending-intake-failed')).toBe(heldBefore);
  });

  test('a file that keeps changing across every run holds the save with the file untouched and the edit kept', async () => {
    const { server: s, docName, file } = await startWithDoc();
    const c = await openClient(s.port, docName);
    const exhaustedBefore = compareCount('pending-exhausted');
    let outsideWrites = 0;
    const realWrite = fsTraced.tracedWriteFile;
    vi.spyOn(fsTraced, 'tracedWriteFile').mockImplementation(async (...args) => {
      await realWrite(...args);
      if (!String(args[0]).startsWith(`${file}.tmp.`)) return;
      outsideWrites++;
      writeFileSync(file, `# Doc\n\noutside write ${outsideWrites}\n\nsecond paragraph\n`);
    });

    typeAfter(c.doc, c.ytext, 'second paragraph', ' typed here');

    await pollUntil(
      () => compareCount('pending-exhausted') > exhaustedBefore,
      8_000,
      25,
      'the exhausted save',
    );
    expect(readFileSync(file, 'utf-8')).toBe(
      `# Doc\n\noutside write ${outsideWrites}\n\nsecond paragraph\n`,
    );
    expect(serverText(s, docName)).toContain('typed here');
    expect(s.instance.durabilityState.isStoreRefused(docName)).toBe(true);
  });

  test('an echo of our own save delivered after the tracker window is recognised by the receipt', async () => {
    const clock = createManualClock(Date.now());
    const double = createWatcherDouble();
    const {
      server: s,
      docName,
      file,
    } = await startWithDoc({
      watcherBackend: double.backend,
      watcherClock: clock,
    });
    const c = await openClient(s.port, docName);
    typeAfter(c.doc, c.ytext, 'second paragraph', ' typed here');
    const saved = '# Doc\n\nfirst paragraph\n\nsecond paragraph typed here\n';
    await pollUntil(() => readFileSync(file, 'utf-8') === saved, 8_000, 25, 'the save');

    clock.advance(25_000);
    const echoesBefore = getMetrics().receiptIntakeSkip.echo ?? 0;
    const reconcilesBefore = getMetrics().reconcileCount;
    double.subscriptionFor(s.contentDir).deliver([{ type: 'update', path: file }]);
    await pollUntil(
      () => {
        clock.advance(50);
        return (getMetrics().receiptIntakeSkip.echo ?? 0) > echoesBefore;
      },
      5_000,
      25,
      'the late echo to reach the intake',
    );

    expect(getMetrics().reconcileCount).toBe(reconcilesBefore);
    expect(serverText(s, docName)).toBe(saved);
    expect(readFileSync(file, 'utf-8')).toBe(saved);
  });

  test('a compare read that is briefly busy is retried and the save lands', async () => {
    const { server: s, docName, file } = await startWithDoc();
    const c = await openClient(s.port, docName);
    const retriesBefore = getMetrics().storeDiskCompareReadRetries;

    process.env.OK_TEST_COMPARE_READ_FAULT = `${docName}:EBUSY:2`;
    typeAfter(c.doc, c.ytext, 'second paragraph', ' typed here');

    await expectDiskAndLiveToSettleOn(
      s,
      docName,
      file,
      '# Doc\n\nfirst paragraph\n\nsecond paragraph typed here\n',
    );
    expect(getMetrics().storeDiskCompareReadRetries).toBe(retriesBefore + 2);
  });

  test('a compare read that stays busy leaves the save pending and the file untouched', async () => {
    const { server: s, docName, file } = await startWithDoc();
    const c = await openClient(s.port, docName);
    const pendingBefore = compareCount('pending-unreadable');

    process.env.OK_TEST_COMPARE_READ_FAULT = `${docName}:EBUSY:1000`;
    typeAfter(c.doc, c.ytext, 'second paragraph', ' typed here');

    await pollUntil(
      () => compareCount('pending-unreadable') > pendingBefore,
      8_000,
      25,
      'the pending save',
    );
    expect(readFileSync(file, 'utf-8')).toBe(SEED);
    expect(serverText(s, docName)).toContain('typed here');
    expect(s.instance.durabilityState.isStoreRefused(docName)).toBe(true);
  });

  test('a write that lands between the compare and the rename is refused and merged on the next run', async () => {
    const { server: s, docName, file } = await startWithDoc();
    const c = await openClient(s.port, docName);
    const refusedBefore = getMetrics().storeRestatRefused;

    process.env.OK_TEST_STORE_RESTAT_RACE = docName;
    typeAfter(c.doc, c.ytext, 'first paragraph', ' typed here');

    await expectDiskAndLiveToSettleOn(
      s,
      docName,
      file,
      '# Doc\n\nfirst paragraph typed here\n\nsecond paragraph\n\nrestat-race-injected\n',
    );
    expect(getMetrics().storeRestatRefused).toBe(refusedBefore + 1);
  });
});

interface HistoryVersion {
  side: string;
  content: string;
}

async function historyVersions(
  target: TestServer,
  docName: string,
  kind: string,
  count: number,
): Promise<HistoryVersion[]> {
  let rows: Array<{ sha: string; checkpoint?: { kind?: string; metadata?: { side?: string } } }> =
    [];
  await pollUntil(
    async () => {
      const res = await fetch(
        `http://127.0.0.1:${target.port}/api/history?docName=${encodeURIComponent(docName)}&limit=100`,
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
      `http://127.0.0.1:${target.port}/api/history/${row.sha}?docName=${encodeURIComponent(docName)}`,
    );
    const body = (await res.json()) as { content: string };
    versions.push({ side: row.checkpoint?.metadata?.side ?? '', content: body.content });
  }
  return versions.sort((a, b) => a.side.localeCompare(b.side));
}

async function startWithUnsavedEdit(
  saved: string,
  edit: { find: string; replace: string },
): Promise<{ server: TestServer; docName: string; file: string }> {
  const started = await createTestServer({
    gitEnabled: true,
    watcherBackend: createWatcherDouble().backend,
    debounce: 300_000,
    maxDebounce: 600_000,
  });
  server = started;
  const docName = `receipt-collide-${randomUUID()}`;
  const file = join(started.contentDir, `${docName}.md`);
  writeFileSync(file, saved);
  client = await createTestClient(started.port, docName);
  const opened = client;
  await pollUntil(() => opened.ytext.toString() === saved, 5_000, 25, 'the seeded document');
  opened.doc.transact(() => {
    const at = opened.ytext.toString().indexOf(edit.find);
    opened.ytext.delete(at, edit.find.length);
    opened.ytext.insert(at, edit.replace);
  });
  await pollUntil(
    () => serverText(started, docName)?.includes(edit.replace) === true,
    5_000,
    25,
    'the unsaved edit to reach the server',
  );
  return { server: started, docName, file };
}

async function runPendingStore(target: TestServer, docName: string): Promise<void> {
  const id = `onStoreDocument-${docName}`;
  if (target.instance.hocuspocus.debouncer.isDebounced(id)) {
    await target.instance.hocuspocus.debouncer.executeNow(id);
  }
}

describe('compare before every Markdown write: an outside edit to the block being saved', () => {
  test('a person save keeps both versions of the block, live and on disk, and both originals in history', async () => {
    const saved = '# Doc\n\nShared paragraph.\n\nTail.\n';
    const {
      server: s,
      docName,
      file,
    } = await startWithUnsavedEdit(saved, {
      find: 'Shared paragraph.',
      replace: 'Shared paragraph, edited here.',
    });
    const bothKeptBefore = getMetrics().reconcileBothKept;
    const outside = '# Doc\n\nShared paragraph, edited outside.\n\nTail.\n';

    writeFileSync(file, outside);
    await runPendingStore(s, docName);

    const bothKept =
      '# Doc\n\nShared paragraph, edited here.\n\nShared paragraph, edited outside.\n\nTail.\n';
    await expectDiskAndLiveToSettleOn(s, docName, file, bothKept);
    expect(getMetrics().reconcileBothKept).toBe(bothKeptBefore + 1);
    expect(s.instance.conflicts.list()).toEqual([]);
    expect(await historyVersions(s, docName, 'external-change-both-kept', 2)).toEqual([
      { side: 'ours', content: '# Doc\n\nShared paragraph, edited here.\n\nTail.\n' },
      { side: 'theirs', content: outside },
    ]);
  });

  test('a person save whose merge fails the fidelity check keeps the version here and moves the outside version to history', async () => {
    const saved = '# Doc\n\nA\n\nB\n\nC\n';
    const {
      server: s,
      docName,
      file,
    } = await startWithUnsavedEdit(saved, {
      find: 'B\n\nC',
      replace: 'X\n\nB edited\n\nC',
    });
    const keptLiveBefore = getMetrics().reconcileKeptLive;
    const outside = '# Doc\n\nA\n\nX\n\nB\n\nC\n';

    writeFileSync(file, outside);
    await runPendingStore(s, docName);

    const here = '# Doc\n\nA\n\nX\n\nB edited\n\nC\n';
    await expectDiskAndLiveToSettleOn(s, docName, file, here);
    expect(getMetrics().reconcileKeptLive).toBe(keptLiveBefore + 1);
    expect(s.instance.conflicts.list()).toEqual([]);
    expect(await historyVersions(s, docName, 'external-change-kept-live', 1)).toEqual([
      { side: 'theirs', content: outside },
    ]);
  });
});
