import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { waitForSavedWork } from '../lib/install-stale-tab-reload-prompt';
import { UNKNOWN_BRANCH_SENTINEL } from './client-persistence';
import { ProviderPool } from './provider-pool';
import { consumeReplayOutboxEntry, writeReplayOutboxEntry } from './replay-outbox';

vi.mock('./replay-outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./replay-outbox')>();
  return {
    ...actual,
    consumeReplayOutboxEntry: vi.fn(actual.consumeReplayOutboxEntry),
  };
});

const DUMMY_WS = 'ws://localhost:1/collab';

function uniqueDocName(): string {
  return `pp-pending-replay-${randomUUID()}`;
}

function buildSourceOnlyState(text: string): { delta: Uint8Array; fullState: Uint8Array } {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, text);
  const fullState = Y.encodeStateAsUpdate(doc);
  const delta = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(new Y.Doc()));
  doc.destroy();
  return { delta, fullState };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await wait(10);
  }
  return predicate();
}

function openSynced(pool: ProviderPool, docName: string) {
  const entry = pool.open(docName);
  if (!entry) throw new Error('expected entry');
  entry.observerCleanup = () => {};
  entry.provider.emit('synced', { state: true });
  return entry;
}

let pool: ProviderPool;

afterEach(() => {
  pool?.dispose();
  vi.mocked(consumeReplayOutboxEntry).mockClear();
});

describe('ProviderPool pending replay', () => {
  it('counts an edit buffered only in memory as unsaved until it replays', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName();
    const marker = `memory-only-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    pool.__test_seedBufferedUpdate(docName, delta, { fullState, durable: false });

    expect(pool.hasAnyUnsyncedWork()).toBe(false);
    expect(pool.hasPendingReplay()).toBe(true);
    await expect(waitForSavedWork(pool, 50)).resolves.toBe('unsaved');

    const entry = openSynced(pool, docName);

    expect(await waitFor(() => !pool.hasPendingReplay())).toBe(true);
    expect(entry.provider.document.getText('source').toString()).toContain(marker);
  });

  it('does not hold a reload for a buffered edit that is already in the outbox', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const { delta, fullState } = buildSourceOnlyState(`durable-${randomUUID()}`);
    pool.__test_seedBufferedUpdate(uniqueDocName(), delta, { fullState, durable: true });

    expect(pool.hasPendingReplay()).toBe(false);
    expect(pool.docNamesToOpenForReplay()).toEqual([]);
  });

  it('names only unopened documents whose buffered edits live in memory alone', () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const memoryOnly = uniqueDocName();
    const durable = uniqueDocName();
    const alreadyOpen = uniqueDocName();
    const first = buildSourceOnlyState(`memory-only-${randomUUID()}`);
    const second = buildSourceOnlyState(`durable-${randomUUID()}`);
    const third = buildSourceOnlyState(`already-open-${randomUUID()}`);
    pool.__test_seedBufferedUpdate(memoryOnly, first.delta, { durable: false });
    pool.__test_seedBufferedUpdate(durable, second.delta, {
      fullState: second.fullState,
      durable: true,
    });
    pool.__test_seedBufferedUpdate(alreadyOpen, third.delta, { durable: false });
    pool.open(alreadyOpen);

    expect(pool.docNamesToOpenForReplay()).toEqual([memoryOnly]);
    expect(pool.hasPendingReplay()).toBe(true);
  });

  it('holds a reload while an open document has edits the server has not acknowledged', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = openSynced(pool, uniqueDocName());
    entry.provider.unsyncedChanges = 1;
    let done = false;

    const waiting = waitForSavedWork(pool, 2_000).then((result) => {
      done = true;
      return result;
    });
    await wait(20);
    expect(done).toBe(false);
    entry.provider.unsyncedChanges = 0;
    entry.provider.emit('unsyncedChanges', { number: 0 });

    await expect(waiting).resolves.toBe('saved');
  });

  it('wakes a waiting reload when a buffered edit is discarded', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const { delta } = buildSourceOnlyState(`discarded-${randomUUID()}`);
    pool.__test_seedBufferedUpdate(uniqueDocName(), delta, { durable: false });

    const waiting = waitForSavedWork(pool, 2_000);
    await wait(0);
    pool.clearBufferedUpdates();

    await expect(waiting).resolves.toBe('saved');
  });

  it('counts a replay as unsaved between claiming the outbox entry and applying it', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName();
    const marker = `claimed-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      { delta, fullState },
    );
    let releaseClaim: () => void = () => {};
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const actual = await vi.importActual<typeof import('./replay-outbox')>('./replay-outbox');
    vi.mocked(consumeReplayOutboxEntry).mockImplementationOnce(async (key) => {
      await claimGate;
      return actual.consumeReplayOutboxEntry(key);
    });

    const entry = openSynced(pool, docName);
    expect(await waitFor(() => vi.mocked(consumeReplayOutboxEntry).mock.calls.length > 0)).toBe(
      true,
    );

    expect(pool.hasAnyUnsyncedWork()).toBe(false);
    expect(pool.hasPendingReplay()).toBe(true);

    releaseClaim();

    expect(await waitFor(() => !pool.hasPendingReplay())).toBe(true);
    expect(entry.provider.document.getText('source').toString()).toContain(marker);
  });

  it('wakes a waiting reload when a replay another tab already claimed ends', async () => {
    pool = new ProviderPool(3, DUMMY_WS);
    const docName = uniqueDocName();
    const { delta, fullState } = buildSourceOnlyState(`claimed-elsewhere-${randomUUID()}`);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      { delta, fullState },
    );
    let releaseClaim: () => void = () => {};
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    vi.mocked(consumeReplayOutboxEntry).mockImplementationOnce(async () => {
      await claimGate;
      return false;
    });

    openSynced(pool, docName);
    expect(await waitFor(() => vi.mocked(consumeReplayOutboxEntry).mock.calls.length > 0)).toBe(
      true,
    );
    const waiting = waitForSavedWork(pool, 2_000);
    await wait(0);
    expect(pool.hasUnsavedWork()).toBe(true);

    releaseClaim();

    await expect(waiting).resolves.toBe('saved');
  });
});
