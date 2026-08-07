/**
 * `useSyncExternalStore` snapshot-stability guard.
 *
 * Every getter passed to `useSyncExternalStore` must return a referentially
 * stable value between real changes — React compares snapshots with `Object.is`
 * and a getter that builds a fresh array per call re-renders forever
 * ("Maximum update depth exceeded"). That failure is invisible to typecheck,
 * lint, and the build: it only appears when the app runs.
 *
 * These tests MUST run against a NON-EMPTY store. The empty case is stable even
 * when the getters are broken (they short-circuit to a frozen empty array), so
 * asserting on an empty store would pass on the buggy implementation and prove
 * nothing.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CommentThreadMeta } from './comments-client';

const QUEUED_META: CommentThreadMeta = {
  threadId: 't1',
  docName: 'notes/rollout',
  anchor: { exact: 'minimal downtime', prefix: '', suffix: '', start: 10, end: 26 },
  state: 'anchored',
  queued: true,
  latestComment: 'still true?',
  createdBy: 'principal-abc',
  createdAt: 1000,
};

vi.mock('./comments-client', () => ({
  listThreads: vi.fn(async () => [QUEUED_META]),
  createThread: vi.fn(async () => QUEUED_META),
  reply: vi.fn(async () => QUEUED_META),
  reopenThread: vi.fn(async () => QUEUED_META),
  replaceAnchor: vi.fn(async () => QUEUED_META),
  queueThread: vi.fn(async () => ({ meta: QUEUED_META, orphaned: false })),
  unqueueThread: vi.fn(async () => QUEUED_META),
  prepareDispatchBatch: vi.fn(async () => ({ results: [] })),
  completeDispatchBatch: vi.fn(async () => ({ results: [] })),
}));

let store: typeof import('./store');

beforeEach(async () => {
  vi.resetModules();
  store = await import('./store');
  // Load real data — the whole point is to assert stability with a populated store.
  await store.refresh('notes/rollout');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSyncExternalStore snapshot stability (populated store)', () => {
  test('the fixture actually populates the queue', () => {
    // Guards the guard: if this ever returns empty, every assertion below is
    // vacuous and would pass against a broken getter.
    expect(store.getQueue()).toEqual(['t1']);
    expect(store.getThreads('notes/rollout')).toHaveLength(1);
  });

  test('getQueue returns the same reference across repeated calls', () => {
    const first = store.getQueue();
    expect(store.getQueue()).toBe(first);
    expect(store.getQueue()).toBe(first);
  });

  test('getSelectedQueue returns the same reference across repeated calls', () => {
    const first = store.getSelectedQueue();
    expect(store.getSelectedQueue()).toBe(first);
    expect(store.getSelectedQueue()).toBe(first);
  });

  test('getThreads returns the same reference across repeated calls', () => {
    const first = store.getThreads('notes/rollout');
    expect(store.getThreads('notes/rollout')).toBe(first);
    expect(store.getThreads('notes/rollout')).toBe(first);
  });

  test('references stay stable across repeated reads after a refresh', async () => {
    // The contract is stability BETWEEN writes, which is what keeps React from
    // looping. A refresh is a write, so it is allowed to hand back new arrays
    // even when the fetched data is identical — the store keys its snapshots on
    // a write counter rather than comparing contents, so it cannot know the
    // refetch changed nothing. That is the deliberate trade: identical data
    // costs one re-render, and no derived view can go stale on a field nobody
    // remembered to compare.
    await store.refresh('notes/rollout');

    const queue = store.getQueue();
    const selected = store.getSelectedQueue();
    const threads = store.getThreads('notes/rollout');

    expect(store.getQueue()).toBe(queue);
    expect(store.getSelectedQueue()).toBe(selected);
    expect(store.getThreads('notes/rollout')).toBe(threads);
  });

  test('deselecting a queued item changes the selection but not the queue', () => {
    const queue = store.getQueue();
    store.toggleQueueSelection('t1');

    expect(store.getSelectedQueue()).toEqual([]); // the one item is unchecked
    expect(store.getQueue()).toBe(queue); // still queued, same reference
  });
});
