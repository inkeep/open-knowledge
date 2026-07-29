/**
 * Cross-tab exactly-once for the durable replay outbox.
 *
 * The outbox record is keyed `(branch, docName)` with no tab component, so
 * every same-origin tab (a browser preview and the desktop shell both sit on
 * `127.0.0.1:PORT`) sees ONE record. That record is therefore the cross-tab
 * claim token: whichever tab consumes it owns the replay and the others must
 * stand down.
 *
 * They must stand down because `replayBufferedContent` is not re-entrant. It
 * decides which CRDT surface holds the un-delivered edit by asking which
 * surface still matches the server — so once another tab has landed the
 * recovered content on the server, this tab's surfaces read INVERTED: the
 * surface that "matches base" is now the stale one, and applying anyway
 * splices the pre-recycle bytes back over the content just recovered. The
 * failure mode is not a duplicate, it is a SILENT REVERT of recovered work.
 *
 * Two pools against the process-global `fake-indexeddb` stand in for two tabs;
 * providers point at a dead URL and are driven by synthetic `synced` emits, so
 * the replay path runs exactly as it does in production without a server.
 */
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

/**
 * A pre-recycle state whose un-delivered edit lives in `Y.Text('source')` with
 * an empty fragment — the unacked source-mode shape. Against an empty fresh
 * doc the replay recovers it; against a doc that ALREADY has it, the surface
 * attribution flips and a re-apply would splice the empty fragment body back
 * over the recovered text.
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

    // Tab A: mid-recycle. Its RAM buffer holds the un-delivered edit and the
    // durable mirror has committed, exactly as `handleServerInstanceMismatch`
    // leaves things.
    expect(
      await writeReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName, { delta, fullState }),
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

    // Tab B opens the same doc with no RAM buffer of its own, reads the shared
    // record, and recovers the edit.
    const tabB = newPool();
    const entryB = tabB.open(docName);
    if (!entryB) throw new Error('expected entry for tab B');
    entryB.observerCleanup = () => {};
    entryB.provider.emit('synced', { state: true });
    expect(
      await waitFor(() => entryB.provider.document.getText('source').toString() === marker),
    ).toBe(true);
    expect(await readReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName)).toBeNull();

    // The recovered content reaches tab A the ordinary way (server → peers).
    entryA.provider.document.getText('source').insert(0, marker);

    // Now tab A's own replay fires. Its pre-recycle replica has ytext=marker
    // and an EMPTY fragment; the server now also has `marker`, so the surface
    // comparison would read the empty fragment as "the base the server
    // rebuilt" and splice it over the recovery — wiping the doc. The lost
    // claim is what stops it.
    entryA.provider.emit('synced', { state: true });
    // `source === marker` is already true from the peer delivery above, so it
    // cannot be the wait predicate (it would pass before tab A's replay even
    // fires). Wait on the positive completion signal — tab A's replay running
    // to completion and standing down, which consumes its RAM buffer — then
    // assert the replay left the recovery intact rather than splicing over it.
    expect(await waitFor(() => tabA.__test_hasBufferedUpdate(docName) === false)).toBe(true);
    expect(entryA.provider.document.getText('source').toString()).toBe(marker);
  });

  it('two fresh tabs racing one record: the loser leaves the recovery alone', async () => {
    const docName = uniqueDocName();
    const marker = `race-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName, { delta, fullState });

    // Neither tab has a RAM buffer: both are post-crash reopens racing the one
    // durable record.
    const tabA = newPool();
    const entryA = tabA.open(docName);
    const tabB = newPool();
    const entryB = tabB.open(docName);
    if (!entryA || !entryB) throw new Error('expected entries');
    entryA.observerCleanup = () => {};
    entryB.observerCleanup = () => {};

    entryA.provider.emit('synced', { state: true });
    entryB.provider.emit('synced', { state: true });
    // Exactly one tab claims the single durable record and replays; the other
    // reads it already-consumed and stands down. The consume is an atomic
    // single-record claim, so once one tab shows the marker the post-state is
    // stable — wait for that instead of a fixed sleep.
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
    // Exactly one tab replays. The other leaves its doc untouched rather than
    // inserting a second copy — these docs are not yet peers, so a duplicate
    // would show up as the marker landing on both.
    expect([textA, textB].filter((t) => t === marker)).toHaveLength(1);
    expect([textA, textB].filter((t) => t === '')).toHaveLength(1);
    expect(await readReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName)).toBeNull();
  });

  it('a RAM-only buffer (no durable mirror) still replays', async () => {
    const docName = uniqueDocName();
    const marker = `ram-only-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);

    // Over-cap docs, failed durable writes, and engines without
    // `indexedDB.databases()` all leave a buffer with no token. Nothing to
    // claim must never read as "someone else claimed it".
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
