/**
 * A thread that goes away stops being the open one.
 *
 * Every OTHER way a thread stands down is a statement about the reader —
 * clicking away in the document, Escape, re-clicking a lit margin marker. This
 * is the case with no reader in it: sending a batch resolves its comments, and
 * a resolved thread drops its highlight AND its margin marker, so nothing is
 * left on screen either pointing at the open thread or offering to clear it.
 * The store is what has to notice, because it is the only thing that sees every
 * mutation — including one made in another window, which arrives over CC1 with
 * no local call to hang the check off.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

/** The list the mocked client answers with — reassigned per test. */
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

// The tab request rides every open; nothing here is about the doc panel.
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

    // What a send does to every comment it carries.
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

    // Orphaned is not open: the highlight is gone, and the card says so in the
    // panel instead. Matches what the in-doc card did with the same state.
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

    // A silent clear would leave the margin marker lit for a thread the store
    // no longer considers open — the exact failure the two-way signal exists
    // to prevent.
    expect(seen).toEqual([null]);
  });

  test('leaves a thread on ANOTHER document alone', async () => {
    // The queue spans the project, so a doc-scoped refresh routinely runs while
    // the open thread belongs to a file this refresh was not about. Checking
    // the per-doc slice would clear it for being absent from the wrong list.
    const store = await import('./store');
    metas = [meta('t1', 'anchored'), { ...meta('t2', 'anchored'), docName: 'notes/other' }];
    await store.refresh('notes/other');
    store.emitOpenThread('t2');

    await store.refresh('notes/rollout');

    expect(store.getOpenThread()).toBe('t2');
  });
});
