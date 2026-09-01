import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { UNKNOWN_BRANCH_SENTINEL } from './client-persistence';
import { ProviderPool } from './provider-pool';
import { readReplayOutboxEntry, writeReplayOutboxEntry } from './replay-outbox';

const DUMMY_WS = 'ws://localhost:1/collab';

function uniqueDocName(): string {
  return `pp-cross-tab-${randomUUID()}`;
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

const pools: ProviderPool[] = [];

function newPool(): ProviderPool {
  const pool = new ProviderPool(3, DUMMY_WS);
  pools.push(pool);
  return pool;
}

afterEach(() => {
  while (pools.length > 0) pools.pop()?.dispose();
});

describe('ProviderPool cross-tab replay claim', () => {
  it('a tab whose RAM buffer lost the shared claim does not revert the recovered content', async () => {
    const docName = uniqueDocName();
    const marker = `cross-tab-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);

    expect(
      await writeReplayOutboxEntry(
        { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
        { delta, fullState },
      ),
    ).toBe(true);
    const tabA = newPool();
    const entryA = tabA.open(docName);
    if (!entryA) throw new Error('expected entry for tab A');
    entryA.observerCleanup = () => {};
    tabA.__test_seedBufferedUpdate(docName, delta, {
      fullState,
      durable: true,
      branch: UNKNOWN_BRANCH_SENTINEL,
    });

    const tabB = newPool();
    const entryB = tabB.open(docName);
    if (!entryB) throw new Error('expected entry for tab B');
    entryB.observerCleanup = () => {};
    entryB.provider.emit('synced', { state: true });
    expect(
      await waitFor(() => entryB.provider.document.getText('source').toString() === marker),
    ).toBe(true);
    expect(
      await readReplayOutboxEntry({
        branch: UNKNOWN_BRANCH_SENTINEL,
        docName,
        namespace: null,
      }),
    ).toBeNull();

    entryA.provider.document.getText('source').insert(0, marker);

    entryA.provider.emit('synced', { state: true });
    expect(await waitFor(() => tabA.__test_hasBufferedUpdate(docName) === false)).toBe(true);
    expect(entryA.provider.document.getText('source').toString()).toBe(marker);
  });

  it('two fresh tabs racing one record: the loser leaves the recovery alone', async () => {
    const docName = uniqueDocName();
    const marker = `race-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      { delta, fullState },
    );

    const tabA = newPool();
    const entryA = tabA.open(docName);
    const tabB = newPool();
    const entryB = tabB.open(docName);
    if (!entryA || !entryB) throw new Error('expected entries');
    entryA.observerCleanup = () => {};
    entryB.observerCleanup = () => {};

    entryA.provider.emit('synced', { state: true });
    entryB.provider.emit('synced', { state: true });
    expect(
      await waitFor(
        () =>
          [entryA, entryB].filter(
            (e) => e.provider.document.getText('source').toString() === marker,
          ).length === 1,
      ),
    ).toBe(true);

    const textA = entryA.provider.document.getText('source').toString();
    const textB = entryB.provider.document.getText('source').toString();
    expect([textA, textB].filter((t) => t === marker)).toHaveLength(1);
    expect([textA, textB].filter((t) => t === '')).toHaveLength(1);
    expect(
      await readReplayOutboxEntry({
        branch: UNKNOWN_BRANCH_SENTINEL,
        docName,
        namespace: null,
      }),
    ).toBeNull();
  });

  it('a RAM-only buffer (no durable mirror) still replays', async () => {
    const docName = uniqueDocName();
    const marker = `ram-only-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);

    const pool = newPool();
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    pool.__test_seedBufferedUpdate(docName, delta, { fullState, durable: false });

    entry.provider.emit('synced', { state: true });

    expect(
      await waitFor(() => entry.provider.document.getText('source').toString() === marker),
    ).toBe(true);
  });
});
