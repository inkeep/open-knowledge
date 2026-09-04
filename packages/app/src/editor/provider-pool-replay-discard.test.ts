import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { UNKNOWN_BRANCH_SENTINEL } from './client-persistence';
import { ProviderPool } from './provider-pool';
import { readReplayOutboxEntry, writeReplayOutboxEntry } from './replay-outbox';

const DUMMY_WS = 'ws://localhost:1/collab';

function uniqueDocName(): string {
  return `pp-discard-${randomUUID()}`;
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

let pool: ProviderPool;
afterEach(() => {
  pool?.dispose();
  vi.restoreAllMocks();
});

describe('ProviderPool replay-buffer discard reaches the durable mirror', () => {
  it('close() drops the durable record, so a reopen replays nothing', async () => {
    const docName = uniqueDocName();
    const marker = `closed-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      { delta, fullState },
    );

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    pool.__test_seedBufferedUpdate(docName, delta, {
      fullState,
      durable: true,
      branch: UNKNOWN_BRANCH_SENTINEL,
    });

    pool.close(docName);

    expect(pool.__test_hasBufferedUpdate(docName)).toBe(false);
    await vi.waitFor(async () => {
      expect(
        await readReplayOutboxEntry({
          branch: UNKNOWN_BRANCH_SENTINEL,
          docName,
          namespace: null,
        }),
      ).toBeNull();
    });

    const reopened = pool.open(docName);
    if (!reopened) throw new Error('expected reopened entry');
    reopened.observerCleanup = () => {};
    reopened.provider.emit('synced', { state: true });
    await wait(120);
    expect(reopened.provider.document.getText('source').toString()).toBe('');
  });

  it('clearBufferedUpdates() drops the durable record under the branch it was captured on', async () => {
    const docName = uniqueDocName();
    const authoringBranch = `feature-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState('branch-a edit');
    await writeReplayOutboxEntry(
      { branch: authoringBranch, docName, namespace: null },
      { delta, fullState },
    );

    pool = new ProviderPool(3, DUMMY_WS);
    pool.__test_seedBufferedUpdate(docName, delta, {
      fullState,
      durable: true,
      branch: authoringBranch,
    });

    pool.clearBufferedUpdates();

    expect(pool.__test_bufferedUpdatesSize()).toBe(0);
    await vi.waitFor(async () => {
      expect(
        await readReplayOutboxEntry({ branch: authoringBranch, docName, namespace: null }),
      ).toBeNull();
    });
  });

  it('a buffer with no durable mirror replays even when the outbox probe throws', async () => {
    const docName = uniqueDocName();
    const marker = `ram-only-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    pool.__test_seedBufferedUpdate(docName, delta, { fullState, durable: false });

    vi.spyOn(indexedDB, 'databases').mockRejectedValue(new Error('databases() unavailable'));

    entry.provider.emit('synced', { state: true });

    expect(
      await waitFor(() => entry.provider.document.getText('source').toString() === marker),
    ).toBe(true);
  });

  it('reports the in-process loss when the entry is replaced mid-consume', async () => {
    const docName = uniqueDocName();
    const { delta, fullState } = buildSourceOnlyState(`abandoned-${randomUUID()}`);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      { delta, fullState },
    );

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    pool.__test_seedBufferedUpdate(docName, delta, {
      fullState,
      durable: true,
      branch: UNKNOWN_BRANCH_SENTINEL,
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    entry.provider.emit('synced', { state: true });
    pool.close(docName);

    await vi.waitFor(() => {
      const events = warn.mock.calls
        .map(([first]) => (typeof first === 'string' ? first : ''))
        .filter((line) => line.includes('ok-buffer-replay-abandoned'));
      expect(events).not.toHaveLength(0);
    });
  });
});
