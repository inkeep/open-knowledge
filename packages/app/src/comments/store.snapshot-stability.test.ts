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
  await store.refresh('notes/rollout');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSyncExternalStore snapshot stability (populated store)', () => {
  test('the fixture actually populates the queue', () => {
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

    expect(store.getSelectedQueue()).toEqual([]);
    expect(store.getQueue()).toBe(queue);
  });
});
