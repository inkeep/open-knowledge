/**
 * Crash-window sweep for the durable replay outbox, with an OCCURRENCE-COUNT
 * oracle.
 *
 * The committed durable-replay tests assert with `.includes()` / absence, which
 * is blind to the failure that actually matters here: a recovered edit applied
 * TWICE. This drives the same ProviderPool durable-replay path against
 * fake-indexeddb and counts, sweeping the consume-first windows:
 *   - crash before consume -> reopen: content present EXACTLY ONCE
 *   - consume-then-apply-fails (the documented at-most-once tail): content
 *     ABSENT (count 0), never doubled
 *   - re-fire (double `synced`, or a later reopen): never a second application
 *
 * Consume-first ordering is what makes the doubled case structurally
 * unreachable — the outbox entry is deleted before the content is applied — so
 * these counts are the invariant that ordering buys.
 */
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
    await writeReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName, { delta, fullState });

    // Reopen (fresh tab, no in-memory buffer): the durable read path fires.
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    entry.provider.emit('synced', { state: true });

    await waitFor(() => entry.provider.document.getText('source').toString().includes(marker));
    const src = entry.provider.document.getText('source').toString();
    expect(count(src, marker)).toBe(1); // EXACTLY once, not merely present
    expect(await readReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName)).toBeNull(); // consumed
  });

  it('WINDOW: consume happens but apply fails (corrupt = the between-consume-and-apply tail) -> content ABSENT (count 0), entry gone, NEVER doubled', async () => {
    const docName = `qa001-${randomUUID()}`;
    const real = buildSourceOnlyState('real content that will be truncated');
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

    // consume-regardless-of-apply: entry gone even though apply threw.
    // Explicit async poll (NOT waitFor's sync predicate — an async predicate
    // returns a truthy Promise and would pass vacuously).
    let consumed = false;
    for (let i = 0; i < 60 && !consumed; i += 1) {
      consumed = (await readReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName)) === null;
      if (!consumed) await wait(10);
    }
    expect(consumed).toBe(true);
    // At-most-once tail loss (the ratified trade): absent, and structurally
    // un-doublable because the entry was deleted before the (failed) apply.
    expect(entry.provider.document.getText('source').toString()).toBe('');
  });

  it('IDEMPOTENCE: a double `synced` fire in the SAME open applies at most once (count<=1, never 2)', async () => {
    const docName = `qa001-${randomUUID()}`;
    const marker = `double-fire-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName, { delta, fullState });

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    // Fire synced twice back-to-back: consume-first must make the second a no-op.
    entry.provider.emit('synced', { state: true });
    entry.provider.emit('synced', { state: true });

    await waitFor(() => entry.provider.document.getText('source').toString().includes(marker));
    await wait(80); // let any second application attempt settle
    const src = entry.provider.document.getText('source').toString();
    expect(count(src, marker)).toBe(1); // NEVER 2 despite two synced fires
  });

  it('REOPEN after a completed recovery: no second application on the next tab (count of applications === 1 total)', async () => {
    const docName = `qa001-${randomUUID()}`;
    const marker = `reopen-once-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName, { delta, fullState });

    pool = new ProviderPool(3, DUMMY_WS);
    const e1 = pool.open(docName);
    if (!e1) throw new Error('expected e1');
    e1.observerCleanup = () => {};
    e1.provider.emit('synced', { state: true });
    await waitFor(() => e1.provider.document.getText('source').toString().includes(marker));
    expect(count(e1.provider.document.getText('source').toString(), marker)).toBe(1);
    pool.dispose();

    // Second tab: outbox consumed, no re-fire; fresh doc stays empty (0 second applies).
    pool = new ProviderPool(3, DUMMY_WS);
    const e2 = pool.open(docName);
    if (!e2) throw new Error('expected e2');
    e2.observerCleanup = () => {};
    e2.provider.emit('synced', { state: true });
    await wait(80);
    expect(count(e2.provider.document.getText('source').toString(), marker)).toBe(0);
    expect(await readReplayOutboxEntry(UNKNOWN_BRANCH_SENTINEL, docName)).toBeNull();
  });
});
