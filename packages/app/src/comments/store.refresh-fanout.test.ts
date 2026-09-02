import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./comments-client', () => {
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
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  test('a doc-scoped refresh makes exactly one project-wide request', async () => {
    const api = await import('./comments-client');
    const store = await import('./store');

    await store.refresh('notes/a');

    expect(api.listThreads).toHaveBeenCalledTimes(1);
    expect(api.listThreads).toHaveBeenCalledWith();
  });

  test('the single fetch populates the per-doc view and the project queue', async () => {
    const api = await import('./comments-client');
    const store = await import('./store');

    await store.refresh('notes/a');

    expect(store.getThreads('notes/a').map((t) => t.id)).toEqual(['t1']);
    expect(store.getQueue()).toEqual(['t1', 't2']);
    expect(api.listThreads).toHaveBeenCalledTimes(1);
  });

  test('the rendered body comes off the cover sheet, with no log read', async () => {
    const store = await import('./store');

    await store.refresh('notes/a');

    expect(store.getThreads('notes/a')[0].body).toBe('still true?');
  });
});
