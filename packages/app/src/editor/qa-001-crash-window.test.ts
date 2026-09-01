import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { UNKNOWN_BRANCH_SENTINEL } from './client-persistence';
import { ProviderPool } from './provider-pool';
import { readReplayOutboxEntry, writeReplayOutboxEntry } from './replay-outbox';

const DUMMY_WS = 'ws://localhost:1/collab';

function count(hay: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
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
afterEach(() => pool?.dispose());

describe('QA-001 crash-window sweep (occurrence-count oracle, ratified consume-first)', () => {
  it('WINDOW: crash before consume -> reopen replays the edit EXACTLY ONCE (count===1, never 2)', async () => {
    const docName = `qa001-${randomUUID()}`;
    const marker = `crash-before-consume-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      { delta, fullState },
    );

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    entry.provider.emit('synced', { state: true });

    await waitFor(() => entry.provider.document.getText('source').toString().includes(marker));
    const src = entry.provider.document.getText('source').toString();
    expect(count(src, marker)).toBe(1);
    expect(
      await readReplayOutboxEntry({
        branch: UNKNOWN_BRANCH_SENTINEL,
        docName,
        namespace: null,
      }),
    ).toBeNull();
  });

  it('WINDOW: consume happens but apply fails (corrupt = the between-consume-and-apply tail) -> content ABSENT (count 0), entry gone, NEVER doubled', async () => {
    const docName = `qa001-${randomUUID()}`;
    const real = buildSourceOnlyState('real content that will be truncated');
    const truncated = real.fullState.slice(0, 4);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      {
        delta: truncated,
        fullState: truncated,
      },
    );

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    entry.provider.emit('synced', { state: true });

    let consumed = false;
    for (let i = 0; i < 60 && !consumed; i += 1) {
      consumed =
        (await readReplayOutboxEntry({
          branch: UNKNOWN_BRANCH_SENTINEL,
          docName,
          namespace: null,
        })) === null;
      if (!consumed) await wait(10);
    }
    expect(consumed).toBe(true);
    expect(entry.provider.document.getText('source').toString()).toBe('');
  });

  it('IDEMPOTENCE: a double `synced` fire in the SAME open applies at most once (count<=1, never 2)', async () => {
    const docName = `qa001-${randomUUID()}`;
    const marker = `double-fire-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      { delta, fullState },
    );

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    entry.provider.emit('synced', { state: true });
    entry.provider.emit('synced', { state: true });

    await waitFor(() => entry.provider.document.getText('source').toString().includes(marker));
    await wait(80);
    const src = entry.provider.document.getText('source').toString();
    expect(count(src, marker)).toBe(1);
  });

  it('REOPEN after a completed recovery: no second application on the next tab (count of applications === 1 total)', async () => {
    const docName = `qa001-${randomUUID()}`;
    const marker = `reopen-once-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      { delta, fullState },
    );

    pool = new ProviderPool(3, DUMMY_WS);
    const e1 = pool.open(docName);
    if (!e1) throw new Error('expected e1');
    e1.observerCleanup = () => {};
    e1.provider.emit('synced', { state: true });
    await waitFor(() => e1.provider.document.getText('source').toString().includes(marker));
    expect(count(e1.provider.document.getText('source').toString(), marker)).toBe(1);
    pool.dispose();

    pool = new ProviderPool(3, DUMMY_WS);
    const e2 = pool.open(docName);
    if (!e2) throw new Error('expected e2');
    e2.observerCleanup = () => {};
    e2.provider.emit('synced', { state: true });
    await wait(80);
    expect(count(e2.provider.document.getText('source').toString(), marker)).toBe(0);
    expect(
      await readReplayOutboxEntry({
        branch: UNKNOWN_BRANCH_SENTINEL,
        docName,
        namespace: null,
      }),
    ).toBeNull();
  });
});
