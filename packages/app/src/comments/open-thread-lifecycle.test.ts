import { beforeEach, describe, expect, test, vi } from 'vitest';

let metas: Array<Record<string, unknown>> = [];

function meta(threadId: string, state: string): Record<string, unknown> {
  return {
    threadId,
    docName: 'notes/rollout',
    anchor: { exact: 'minimal downtime', prefix: '', suffix: '', start: 0, end: 16 },
    state,
    queued: true,
    latestComment: 'still true?',
    createdBy: 'principal-abc',
    createdAt: 900,
  };
}

vi.mock('./comments-client', () => ({
  listThreads: vi.fn(async () => metas),
  createThread: vi.fn(),
  editComment: vi.fn(),
  reopenThread: vi.fn(),
  replaceAnchor: vi.fn(),
  queueThread: vi.fn(),
  unqueueThread: vi.fn(),
  deleteThread: vi.fn(),
  prepareDispatchBatch: vi.fn(async () => ({ results: [] })),
  completeDispatchBatch: vi.fn(async () => ({ results: [] })),
}));

vi.mock('@/components/doc-panel-events', () => ({ requestDocPanelTab: vi.fn() }));

describe('the open thread across a refresh', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    metas = [meta('t1', 'anchored')];
  });

  test('survives a refresh that still lists it as open', async () => {
    const store = await import('./store');
    await store.refresh('notes/rollout');
    store.emitOpenThread('t1');

    await store.refresh('notes/rollout');

    expect(store.getOpenThread()).toBe('t1');
  });

  test('stands down when its thread resolves', async () => {
    const store = await import('./store');
    await store.refresh('notes/rollout');
    store.emitOpenThread('t1');

    metas = [meta('t1', 'resolved')];
    await store.refresh('notes/rollout');

    expect(store.getOpenThread()).toBeNull();
  });

  test('stands down when its thread is deleted', async () => {
    const store = await import('./store');
    await store.refresh('notes/rollout');
    store.emitOpenThread('t1');

    metas = [];
    await store.refresh('notes/rollout');

    expect(store.getOpenThread()).toBeNull();
  });

  test('stands down when its passage is lost, like the card that used to', async () => {
    const store = await import('./store');
    await store.refresh('notes/rollout');
    store.emitOpenThread('t1');

    metas = [meta('t1', 'orphaned')];
    await store.refresh('notes/rollout');

    expect(store.getOpenThread()).toBeNull();
  });

  test('tells its subscribers, so the rail and the panel clear too', async () => {
    const store = await import('./store');
    await store.refresh('notes/rollout');
    store.emitOpenThread('t1');

    const seen: (string | null)[] = [];
    const stop = store.subscribeOpenThread((id) => seen.push(id));
    metas = [];
    await store.refresh('notes/rollout');
    stop();

    expect(seen).toEqual([null]);
  });

  test('leaves a thread on ANOTHER document alone', async () => {
    const store = await import('./store');
    metas = [meta('t1', 'anchored'), { ...meta('t2', 'anchored'), docName: 'notes/other' }];
    await store.refresh('notes/other');
    store.emitOpenThread('t2');

    await store.refresh('notes/rollout');

    expect(store.getOpenThread()).toBe('t2');
  });
});
