/**
 * Unit tests for durable replay-outbox recovery in ProviderPool.
 *
 * These construct a real HocuspocusProvider against a dead URL (never
 * connects) and drive the replay listener via a synthetic `synced` emit,
 * against the globally-installed `fake-indexeddb`. They cover the reopen path:
 * a fresh tab (no in-memory buffer) recovers an unsynced edit from the durable
 * outbox, consumes it before applying (so a reopen never re-applies), and
 * never crashes on a corrupt buffer.
 *
 * The content-level replay against a REAL server (Observer B derive, real
 * `theirs` comparison) is exercised in
 * `tests/integration/replay-outbox-durable.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { UNKNOWN_BRANCH_SENTINEL } from './client-persistence';
import { ProviderPool } from './provider-pool';
import { readReplayOutboxEntry, writeReplayOutboxEntry } from './replay-outbox';

// Spy-wrap the REAL outbox module (no behavior change) so the replay
// listener's own invocation count is observable. Its first act on a fresh tab
// is the outbox read, which makes that count the direct reading of "how many
// times did the replay run".
vi.mock('./replay-outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./replay-outbox')>();
  return {
    ...actual,
    readReplayOutboxEntry: vi.fn(actual.readReplayOutboxEntry),
    consumeReplayOutboxEntry: vi.fn(actual.consumeReplayOutboxEntry),
  };
});

const DUMMY_WS = 'ws://localhost:1/collab';

function uniqueDocName(): string {
  return `pp-durable-${randomUUID()}`;
}

/**
 * Build a source-only pre-recycle state: an unsynced edit lives in
 * `Y.Text('source')`, the XML fragment is empty. Against an empty fresh doc
 * (the unit tier's dead-URL provider), the content-level replay's fragment-
 * clean branch splices the recovered source in.
 */
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
});

describe('ProviderPool durable replay outbox', () => {
  it('recovers an unsynced edit from the durable outbox on a fresh open', async () => {
    const docName = uniqueDocName();
    const marker = `durable-recovered-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName, { delta, fullState });

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    entry.provider.emit('synced', { state: true });

    const recovered = await waitFor(() =>
      entry.provider.document.getText('source').toString().includes(marker),
    );
    expect(recovered).toBe(true);
    // Consume-first: the durable outbox is gone after recovery.
    expect(await readReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName)).toBeNull();
  });

  it('does not re-apply after a completed recovery (exactly-once across reopen)', async () => {
    const docName = uniqueDocName();
    const marker = `once-only-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName, { delta, fullState });

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    entry.provider.emit('synced', { state: true });
    await waitFor(() => entry.provider.document.getText('source').toString().includes(marker));
    pool.dispose();

    // A second fresh tab: the outbox was consumed, so no replay fires and the
    // fresh doc stays empty — the recovered content is NOT re-inserted.
    pool = new ProviderPool(3, DUMMY_WS);
    const entry2 = pool.open(docName);
    if (!entry2) throw new Error('expected entry2');
    entry2.observerCleanup = () => {};
    entry2.provider.emit('synced', { state: true });
    await wait(80);
    expect(entry2.provider.document.getText('source').toString()).toBe('');
    expect(await readReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName)).toBeNull();
  });

  it('a second `synced` never re-enters the replay', async () => {
    const docName = uniqueDocName();
    const marker = `single-fire-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName, { delta, fullState });

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};

    vi.mocked(readReplayOutboxEntry).mockClear();

    // A reconnect can re-emit `synced` while the first replay is still inside
    // its awaits — the record is not consumed yet, so a second entrant would
    // read the SAME buffer and race the consume the design exists to make
    // single-fire. The listener detaches itself synchronously before the first
    // await for exactly this reason; both emits land in that window.
    entry.provider.emit('synced', { state: true });
    entry.provider.emit('synced', { state: true });

    const recovered = await waitFor(() =>
      entry.provider.document.getText('source').toString().includes(marker),
    );
    expect(recovered).toBe(true);
    await wait(80);

    expect(vi.mocked(readReplayOutboxEntry)).toHaveBeenCalledTimes(1);
    // And the user-visible outcome: one copy of the recovered edit.
    expect(entry.provider.document.getText('source').toString()).toBe(marker);
  });

  it('consumes the outbox and does not crash on a corrupt buffer', async () => {
    const docName = uniqueDocName();
    // Valid record shape, but a truncated Yjs update — the guarded apply must
    // not crash the client, and the outbox is consumed before the apply is
    // attempted (consume-first) so it can never re-fire.
    const real = buildSourceOnlyState('some real content that will be truncated');
    const truncated = real.fullState.slice(0, 4);
    await writeReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName, {
      delta: truncated,
      fullState: truncated,
    });

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    entry.provider.emit('synced', { state: true });

    // The outbox is consumed regardless of the apply outcome (consume-first).
    let consumed = false;
    for (let i = 0; i < 60 && !consumed; i += 1) {
      consumed = (await readReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName)) === null;
      if (!consumed) await wait(10);
    }
    expect(consumed).toBe(true);
    // No meaningful content was fabricated from the corrupt bytes.
    expect(entry.provider.document.getText('source').toString()).toBe('');
  });
});
