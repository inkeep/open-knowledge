/**
 * One request per refresh.
 *
 * Loading the thread list used to cost `2 + 2N` round trips per mutation — the
 * open doc's threads, the project's threads, then every thread's full event log
 * — to render a panel that only ever shows each thread's newest comment. That
 * regression is invisible to typecheck, to lint, and to every other test here:
 * the data is identical either way, it just arrives N times slower. So the
 * request count itself is the assertion.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./comments-client', () => {
  // Everything the factory needs must be defined INSIDE it — `vi.mock` is
  // hoisted above module-level declarations.
  const metas = [
    {
      threadId: 't1',
      docName: 'notes/a',
      anchor: { exact: 'minimal downtime', prefix: '', suffix: '', start: 0, end: 16 },
      state: 'anchored',
      queued: true,
      latestComment: 'still true?',
      createdBy: 'principal-abc',
      createdAt: 900,
    },
    {
      threadId: 't2',
      docName: 'notes/b',
      anchor: { exact: 'ship by Q3', prefix: '', suffix: '', start: 0, end: 10 },
      state: 'anchored',
      queued: true,
      latestComment: 'which Q3?',
      createdBy: 'principal-abc',
      createdAt: 1000,
    },
  ];
  return {
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
  };
});

describe('refresh fan-out', () => {
  // A fresh store per test, and fresh call counts: the mocked client module
  // survives `resetModules`, so without the clear each test would also be
  // counting the previous one's requests.
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  test('a doc-scoped refresh makes exactly one project-wide request', async () => {
    const api = await import('./comments-client');
    const store = await import('./store');

    await store.refresh('notes/a');

    expect(api.listThreads).toHaveBeenCalledTimes(1);
    // No argument: the project-wide list is a superset of every per-doc view,
    // so asking for one doc's threads separately is a wasted round trip.
    expect(api.listThreads).toHaveBeenCalledWith();
  });

  test('the single fetch populates the per-doc view and the project queue', async () => {
    const api = await import('./comments-client');
    const store = await import('./store');

    await store.refresh('notes/a');

    // Guards the guard: an empty store would make the count assertion above
    // pass for the wrong reason.
    expect(store.getThreads('notes/a').map((t) => t.id)).toEqual(['t1']);
    expect(store.getQueue()).toEqual(['t1', 't2']);
    expect(api.listThreads).toHaveBeenCalledTimes(1);
  });

  test('the rendered body comes off the cover sheet, with no log read', async () => {
    // The projected `latestComment` is what removed the per-thread log fetch —
    // if it stops being the body source, the N reads come straight back.
    const store = await import('./store');

    await store.refresh('notes/a');

    expect(store.getThreads('notes/a')[0].body).toBe('still true?');
  });
});
