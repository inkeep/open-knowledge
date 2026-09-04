import './idb-preload';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  createClientPersistence,
  UNKNOWN_BRANCH_SENTINEL,
} from '../../src/editor/client-persistence';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  awaitFileWatcherIndexed,
  createTestServer,
  getServerState,
  pollUntil,
  seedPoolServerInstanceId,
  wait,
} from './test-harness';

const FIXTURE_V1 = `# Lineage Fixture

Stable paragraph: shared marker LINEAGE-ALPHA.

## Session One Section

Paragraph with marker LINEAGE-V1-ONLY that the rewrite removes.
`;

const FIXTURE_V2 = `# Lineage Fixture

Stable paragraph: shared marker LINEAGE-ALPHA.

## Session Two Section

Paragraph with marker LINEAGE-V2-ONLY introduced by the rewrite.
`;

const ENVELOPE_KEY = 'ok-doc-lineage-epochs';

const HYDRATION_WINDOW_MS = 5_000;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function hasUnionMergeArtifacts(text: string): boolean {
  return (
    countOccurrences(text, 'LINEAGE-ALPHA') > 1 || countOccurrences(text, 'LINEAGE-V1-ONLY') > 0
  );
}

async function settleHydrationWindow(read: () => string, doneEarly?: () => boolean): Promise<void> {
  const deadline = Date.now() + HYDRATION_WINDOW_MS;
  while (Date.now() < deadline) {
    if (hasUnionMergeArtifacts(read())) return;
    if (doneEarly?.() === true) return;
    await wait(100);
  }
}

async function readPersistedYtext(docName: string, serverInstanceId: string): Promise<string> {
  const doc = new Y.Doc();
  const persistence = createClientPersistence({
    branch: UNKNOWN_BRANCH_SENTINEL,
    serverInstanceId,
    docName,
    doc,
  });
  try {
    await persistence.whenSynced;
    return doc.getText('source').toString();
  } finally {
    await persistence.destroy();
    doc.destroy();
  }
}

function makeStubStorage(): {
  stub: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return { stub, store };
}

function captureLineageMismatchWarns(): {
  emitted: string[];
  restore: () => void;
} {
  const emitted: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === 'string' && first.includes('ok-doc-lineage-mismatch')) {
      emitted.push(first);
    }
    original.apply(console, args);
  };
  return {
    emitted,
    restore: () => {
      console.warn = original;
    },
  };
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function stageStaleRowsAndReseed(opts: {
  server: Awaited<ReturnType<typeof createTestServer>>;
  docName: string;
  filePath: string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}): Promise<void> {
  const { server, docName, filePath, storage } = opts;
  const poolA = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, { storage });
  const serverInstanceId = await seedPoolServerInstanceId(server, poolA);
  poolA.open(docName);
  poolA.setActive(docName);
  await pollUntil(() => poolA.getActive()?.provider.isSynced === true, 15_000, 50);
  await pollUntil(() => poolA.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);
  const session1Text = poolA.getActive()?.provider.document.getText('source').toString() ?? '';
  expect(countOccurrences(session1Text, 'LINEAGE-ALPHA')).toBe(1);
  expect(countOccurrences(session1Text, 'LINEAGE-V1-ONLY')).toBe(1);

  await pollUntil(
    async () =>
      countOccurrences(await readPersistedYtext(docName, serverInstanceId), 'LINEAGE-V1-ONLY') > 0,
    10_000,
    100,
  );

  poolA.dispose();

  rmSync(filePath);
  await pollUntil(() => getServerState(server, docName) === null, 20_000, 100);
  writeFileSync(filePath, FIXTURE_V2, 'utf-8');
  await awaitFileWatcherIndexed(server, docName);
}

async function assertSingleLineageEverywhere(opts: {
  clientYtext: () => string;
  serverYtext: () => string;
  filePath: string;
}): Promise<void> {
  const { clientYtext, serverYtext, filePath } = opts;

  const clientText = clientYtext();
  expect(countOccurrences(clientText, 'LINEAGE-ALPHA')).toBe(1);
  expect(countOccurrences(clientText, 'LINEAGE-V1-ONLY')).toBe(0);
  expect(countOccurrences(clientText, 'LINEAGE-V2-ONLY')).toBe(1);

  await pollUntil(() => clientYtext().length > 0 && clientYtext() === serverYtext(), 10_000, 100);
  expect(clientYtext()).toBe(FIXTURE_V2);
  expect(countOccurrences(serverYtext(), 'LINEAGE-ALPHA')).toBe(1);

  await wait(1500);
  const diskContent = readFileSync(filePath, 'utf-8');
  expect(countOccurrences(diskContent, 'LINEAGE-ALPHA')).toBe(1);
  expect(countOccurrences(diskContent, 'LINEAGE-V1-ONLY')).toBe(0);
  expect(countOccurrences(diskContent, 'LINEAGE-V2-ONLY')).toBe(1);
}

describe('client-persisted state meets a re-seeded doc lineage (boot-window fresh-pool door)', () => {
  test('a fresh pool that opened during the instance-unknown window must not hydrate a stale lineage when the id lands', async () => {
    const server = await createTestServer();
    cleanups.push(() => server.cleanup());

    const docName = `lineage-bootwindow-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, FIXTURE_V1, 'utf-8');
    await awaitFileWatcherIndexed(server, docName);

    const { stub: sharedStorage, store } = makeStubStorage();
    await stageStaleRowsAndReseed({ server, docName, filePath, storage: sharedStorage });

    const envelopeRaw = store.get(ENVELOPE_KEY) ?? null;
    expect(envelopeRaw).not.toBeNull();
    expect(envelopeRaw as string).toContain(docName);

    const poolB = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      storage: sharedStorage,
    });
    cleanups.push(() => poolB.dispose());
    poolB.open(docName);
    poolB.setActive(docName);
    await pollUntil(() => poolB.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => poolB.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);

    const clientYtext = (): string =>
      poolB.getActive()?.provider.document.getText('source').toString() ?? '';
    const serverYtext = (): string => getServerState(server, docName)?.ytext.toString() ?? '';

    expect(poolB.getActive()?.persistence ?? null).toBeNull();
    const preAttachText = clientYtext();
    expect(countOccurrences(preAttachText, 'LINEAGE-ALPHA')).toBe(1);
    expect(countOccurrences(preAttachText, 'LINEAGE-V1-ONLY')).toBe(0);
    expect(countOccurrences(preAttachText, 'LINEAGE-V2-ONLY')).toBe(1);

    await seedPoolServerInstanceId(server, poolB);
    await settleHydrationWindow(clientYtext);

    await assertSingleLineageEverywhere({ clientYtext, serverYtext, filePath });
  }, 120_000);
});

describe('client-persisted state meets a re-seeded doc lineage (record-absent profile door)', () => {
  test('a claimless open over surviving IDB rows must not hydrate a stale lineage into the re-seeded doc', async () => {
    const server = await createTestServer();
    cleanups.push(() => server.cleanup());

    const docName = `lineage-noenvelope-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, FIXTURE_V1, 'utf-8');
    await awaitFileWatcherIndexed(server, docName);

    const { stub: storageA } = makeStubStorage();
    await stageStaleRowsAndReseed({ server, docName, filePath, storage: storageA });

    const { stub: emptyStorage } = makeStubStorage();
    const poolB = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      storage: emptyStorage,
    });
    cleanups.push(() => poolB.dispose());
    await seedPoolServerInstanceId(server, poolB);
    poolB.open(docName);
    poolB.setActive(docName);
    await pollUntil(() => poolB.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => poolB.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);

    const clientYtext = (): string =>
      poolB.getActive()?.provider.document.getText('source').toString() ?? '';
    const serverYtext = (): string => getServerState(server, docName)?.ytext.toString() ?? '';

    await settleHydrationWindow(clientYtext);

    await assertSingleLineageEverywhere({ clientYtext, serverYtext, filePath });
  }, 120_000);
});

describe('refusing dead-lineage state is observable (boot-window fresh-pool door)', () => {
  test('fencing the late attach emits the structured ok-doc-lineage-mismatch recovery event', async () => {
    const server = await createTestServer();
    cleanups.push(() => server.cleanup());

    const docName = `lineage-bootwindow-telemetry-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, FIXTURE_V1, 'utf-8');
    await awaitFileWatcherIndexed(server, docName);

    const { stub: sharedStorage } = makeStubStorage();
    await stageStaleRowsAndReseed({ server, docName, filePath, storage: sharedStorage });

    const capture = captureLineageMismatchWarns();
    cleanups.push(capture.restore);

    const poolB = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      storage: sharedStorage,
    });
    cleanups.push(() => poolB.dispose());
    poolB.open(docName);
    poolB.setActive(docName);
    await pollUntil(() => poolB.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => poolB.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);

    const clientYtext = (): string =>
      poolB.getActive()?.provider.document.getText('source').toString() ?? '';

    await seedPoolServerInstanceId(server, poolB);
    await settleHydrationWindow(clientYtext, () => capture.emitted.length > 0);
    capture.restore();

    expect(capture.emitted.length).toBeGreaterThanOrEqual(1);
    const events = capture.emitted.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.some((e) => e.docName === docName && e.via === 'stored-state-validation')).toBe(
      true,
    );
  }, 120_000);
});

describe('refusing dead-lineage state is observable (record-absent profile door)', () => {
  test('fencing the claimless admission attach emits the structured ok-doc-lineage-mismatch recovery event', async () => {
    const server = await createTestServer();
    cleanups.push(() => server.cleanup());

    const docName = `lineage-noenvelope-telemetry-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, FIXTURE_V1, 'utf-8');
    await awaitFileWatcherIndexed(server, docName);

    const { stub: storageA } = makeStubStorage();
    await stageStaleRowsAndReseed({ server, docName, filePath, storage: storageA });

    const capture = captureLineageMismatchWarns();
    cleanups.push(capture.restore);

    const { stub: emptyStorage } = makeStubStorage();
    const poolB = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      storage: emptyStorage,
    });
    cleanups.push(() => poolB.dispose());
    await seedPoolServerInstanceId(server, poolB);
    poolB.open(docName);
    poolB.setActive(docName);
    await pollUntil(() => poolB.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => poolB.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);

    const clientYtext = (): string =>
      poolB.getActive()?.provider.document.getText('source').toString() ?? '';

    await settleHydrationWindow(clientYtext, () => capture.emitted.length > 0);
    capture.restore();

    expect(capture.emitted.length).toBeGreaterThanOrEqual(1);
    const events = capture.emitted.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.some((e) => e.docName === docName && e.via === 'stored-state-validation')).toBe(
      true,
    );
  }, 120_000);
});
