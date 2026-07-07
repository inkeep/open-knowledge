/**
 * Doc-lineage consistency for client-persisted state — the two remaining
 * doors into the union-merge corruption: the record-ABSENT population
 * that `stale-idb-lineage-doors.test.ts` (doors 1-2, record present)
 * deliberately does not reach.
 *
 * Invariant under test (same as the sibling files): client-persisted
 * Y.Doc state must only ever rejoin the Yjs lineage it was persisted
 * from. The server mints a fresh lineage whenever it re-seeds a doc
 * from disk (unload + reload), while the client's IndexedDB cache for
 * the doc survives — so stale state can meet a fresh lineage of the
 * same doc, and Yjs union-merges the two independent materializations:
 * shared content doubles, removed content resurrects.
 *
 * Door 3 — boot-window fresh-pool rejoin. Session 1 happens in tab A
 * with the instance id known (envelope record written, IDB rows
 * persisted); tab A closes. The file is deleted and recreated while no
 * tab is open (fresh lineage on next load). Tab B — a brand-new pool
 * over the same localStorage + IndexedDB substrate — opens the doc
 * BEFORE the server-info fetch lands. The fresh pool's in-memory record
 * map is empty and the envelope is not consumable while the instance id
 * is unknown, so the open-time record snapshot is null; when the id
 * lands, the deferred attach sees no record for the stale rows it is
 * about to hydrate. This is the unpinned combination of the sibling's
 * two doors: door 1 covers same-pool (in-memory record present), door 2
 * covers fresh-pool with the id known before open (envelope readable).
 * The instance-unknown window is a standing production state: every
 * page load opens docs before the server-info fetch lands.
 *
 * Door 4 — record-absent profile. Same staging, but tab B's
 * localStorage is empty while IndexedDB survives (browsers evict the
 * two stores independently; profiles written before the epoch record
 * existed never had an envelope at all). The instance id IS known at
 * open, so the auth token claims nothing (the server accepts absent
 * claims by design) and persistence attaches at admission time with no
 * lineage record to validate against.
 *
 * Contract (identical to the sibling files, asserted per door): after
 * the rejoin settles, the client, the server, and disk all hold exactly
 * the current disk content — shared content exactly once, no
 * resurrection of removed content. How the seam achieves that — block,
 * validate-then-attach, or recover via close/clear/reopen — is
 * deliberately not pinned.
 *
 * Observability (separate focused tests, one per door): when the seam
 * refuses dead-lineage state on these doors, the refusal must be
 * observable as the same structured `ok-doc-lineage-mismatch` client
 * recovery event the record-present arms already emit — a silent fence
 * leaves field occurrences of this corruption class invisible.
 */
import './idb-preload';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * localStorage key of the doc-lineage epoch envelope. Module-private in
 * provider-pool.ts (DOC_LINEAGE_EPOCHS_KEY); duplicated here the same
 * way provider-pool.test.ts duplicates it, as a staging-sanity probe
 * only — door 3 is sharp precisely because the envelope IS present and
 * merely unreadable during the boot window.
 */
const ENVELOPE_KEY = 'ok-doc-lineage-epochs';

/**
 * How long a stale-IDB hydration gets to land before the contract is
 * asserted. On the in-memory fake-IDB substrate the whole chain —
 * attach → IDB read → union-merge → WS round-trip — completes well
 * under a second, so this is a generous ceiling, not a tuning knob.
 */
const HYDRATION_WINDOW_MS = 5_000;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function hasUnionMergeArtifacts(text: string): boolean {
  return (
    countOccurrences(text, 'LINEAGE-ALPHA') > 1 || countOccurrences(text, 'LINEAGE-V1-ONLY') > 0
  );
}

/**
 * Mechanism-neutral settle after the rejoin: gives any stale-IDB
 * hydration every chance to land WITHOUT pinning how the seam reacts
 * (attach, validate-then-attach, or recover via close/clear/reopen —
 * polling for `persistence !== null` here would couple the test to one
 * recovery shape). Returns early as soon as duplication is observed so
 * a violation fails on an assertion, not a timeout; `doneEarly` lets
 * the telemetry tests return as soon as their signal arrives.
 */
async function settleHydrationWindow(read: () => string, doneEarly?: () => boolean): Promise<void> {
  const deadline = Date.now() + HYDRATION_WINDOW_MS;
  while (Date.now() < deadline) {
    if (hasUnionMergeArtifacts(read())) return;
    if (doneEarly?.() === true) return;
    await wait(100);
  }
}

/**
 * Read the ytext persisted client-side for (branch, instanceId, docName)
 * through the production persistence factory. Stages nothing — used only to
 * confirm the precondition "session 1 left durable client-persisted state
 * behind" before the doc is unloaded, so the test cannot go green by simply
 * having raced the IDB flush. Same probe as the sibling files.
 */
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

/**
 * Map-backed localStorage stub — the pool constructor's `storage` seam,
 * same shape as the sibling files. Sharing ONE stub between two pools
 * models same-origin localStorage as seen by two successive tabs.
 */
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

/**
 * Capture structured `ok-doc-lineage-mismatch` client recovery events
 * (emitted as JSON lines via console.warn) while forwarding everything
 * to the real console so server-side diagnostics stay visible.
 */
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

/**
 * Session 1: sync the doc through tab A's pool (instance id known →
 * admission-time persistence attach), gate on durable IDB rows, close
 * the tab, then rewrite the file while no tab is open. The watcher
 * delete path force-unloads the server-side doc; the recreate stays
 * unloaded until the next connection re-seeds it as a fresh lineage.
 */
async function stageStaleRowsAndReseed(opts: {
  server: Awaited<ReturnType<typeof createTestServer>>;
  docName: string;
  filePath: string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}): Promise<void> {
  const { server, docName, filePath, storage } = opts;
  const poolA = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, { storage });
  // Not pushed to cleanups: disposed inline below, before the rewrite.
  const serverInstanceId = await seedPoolServerInstanceId(server, poolA);
  poolA.open(docName);
  poolA.setActive(docName);
  await pollUntil(() => poolA.getActive()?.provider.isSynced === true, 15_000, 50);
  await pollUntil(() => poolA.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);
  const session1Text = poolA.getActive()?.provider.document.getText('source').toString() ?? '';
  expect(countOccurrences(session1Text, 'LINEAGE-ALPHA')).toBe(1);
  expect(countOccurrences(session1Text, 'LINEAGE-V1-ONLY')).toBe(1);

  // Precondition gate: durable client-persisted state exists before the
  // tab closes.
  await pollUntil(
    async () =>
      countOccurrences(await readPersistedYtext(docName, serverInstanceId), 'LINEAGE-V1-ONLY') > 0,
    10_000,
    100,
  );

  // Tab A closes entirely. dispose() destroys providers and persistence
  // HANDLES; the IDB data survives — a closed tab leaves its cache
  // behind. That durability is the feature under test.
  poolA.dispose();

  // External rewrite while no tab is open: delete + recreate with drifted
  // content.
  rmSync(filePath);
  await pollUntil(() => getServerState(server, docName) === null, 20_000, 100);
  writeFileSync(filePath, FIXTURE_V2, 'utf-8');
  await awaitFileWatcherIndexed(server, docName);
}

/** Assert the full no-corruption contract: client, server, and disk. */
async function assertSingleLineageEverywhere(opts: {
  clientYtext: () => string;
  serverYtext: () => string;
  filePath: string;
}): Promise<void> {
  const { clientYtext, serverYtext, filePath } = opts;

  // THE CONTRACT: the client shows the current disk content exactly once —
  // shared content not duplicated, removed content not resurrected.
  const clientText = clientYtext();
  expect(countOccurrences(clientText, 'LINEAGE-ALPHA')).toBe(1);
  expect(countOccurrences(clientText, 'LINEAGE-V1-ONLY')).toBe(0);
  expect(countOccurrences(clientText, 'LINEAGE-V2-ONLY')).toBe(1);

  // Client and server converge on that same single-copy text.
  await pollUntil(() => clientYtext().length > 0 && clientYtext() === serverYtext(), 10_000, 100);
  expect(clientYtext()).toBe(FIXTURE_V2);
  expect(countOccurrences(serverYtext(), 'LINEAGE-ALPHA')).toBe(1);

  // The corruption must not reach disk either. "Nothing was written" has
  // no event to wait on, so wait out the persistence debounce horizon
  // (debounce 200ms, maxDebounce 1000ms in the harness) before reading.
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

    // One storage substrate shared by both pools — same-origin
    // localStorage as two successive tabs see it. The fake-IDB substrate
    // (idb-preload) is process-global, so it is shared by construction.
    const { stub: sharedStorage, store } = makeStubStorage();
    await stageStaleRowsAndReseed({ server, docName, filePath, storage: sharedStorage });

    // Staging sanity: the envelope record session 1 persisted IS present
    // for tab B — this door exists because the boot window cannot read
    // it yet, not because it is missing.
    const envelopeRaw = store.get(ENVELOPE_KEY) ?? null;
    expect(envelopeRaw).not.toBeNull();
    expect(envelopeRaw as string).toContain(docName);

    // Session 2 — tab B: brand-new pool, doc opened BEFORE the
    // server-info fetch lands (the instance-unknown boot window every
    // page load passes through).
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

    // Pre-attach sanity: admission-time persistence attach was skipped
    // (no instance id → the IDB name cannot be derived), so the doc holds
    // exactly the fresh lineage. Whatever happens next can only come from
    // how the seam handles the late attach.
    expect(poolB.getActive()?.persistence ?? null).toBeNull();
    const preAttachText = clientYtext();
    expect(countOccurrences(preAttachText, 'LINEAGE-ALPHA')).toBe(1);
    expect(countOccurrences(preAttachText, 'LINEAGE-V1-ONLY')).toBe(0);
    expect(countOccurrences(preAttachText, 'LINEAGE-V2-ONLY')).toBe(1);

    // The server-info fetch lands: the pool learns the instance id while
    // holding stale IDB rows and no readable lineage record for them.
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

    // Session 1 writes under storage substrate A; its envelope is then
    // discarded — modeling localStorage eviction with IndexedDB surviving
    // (the stores evict independently), or a profile written before the
    // epoch record existed.
    const { stub: storageA } = makeStubStorage();
    await stageStaleRowsAndReseed({ server, docName, filePath, storage: storageA });

    // Session 2 — tab B: brand-new pool with EMPTY localStorage over the
    // process-global fake-IDB substrate that still holds session 1's
    // rows. Boot order mirrors door 2's production-blessed ordering:
    // server-info first, then the user navigates to the doc — so
    // persistence attaches at admission time with nothing to claim.
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

    // The refusal must be observable: silent fencing (or silent
    // corruption) leaves field occurrences of this class invisible.
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
