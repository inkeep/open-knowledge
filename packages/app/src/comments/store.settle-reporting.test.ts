import { beforeEach, describe, expect, test, vi } from 'vitest';

const toasted: string[] = [];
vi.mock('sonner', () => ({
  toast: { error: (message: string) => toasted.push(message) },
}));

vi.mock('./comments-client', () => ({
  listThreads: vi.fn(async () => []),
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

describe('mutation reporting', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    toasted.length = 0;
  });

  test('a refresh that fails after an accepted edit reports nothing', async () => {
    const api = await import('./comments-client');
    const store = await import('./store');
    vi.mocked(api.editComment).mockResolvedValue(undefined as never);
    vi.mocked(api.listThreads).mockRejectedValue(new Error('network down'));

    store.editComment('t1', 'still true?');

    await vi.waitFor(() => expect(api.listThreads).toHaveBeenCalled());
    expect(toasted).toEqual([]);
  });

  test('a refused edit says so, in the server’s own words', async () => {
    const api = await import('./comments-client');
    const store = await import('./store');
    vi.mocked(api.editComment).mockRejectedValue(
      new Error('The quoted passage is not in the document'),
    );

    store.editComment('t1', 'still true?');

    await vi.waitFor(() => expect(toasted).toHaveLength(1));
    expect(toasted[0]).toContain('The quoted passage is not in the document');
    expect(api.listThreads).toHaveBeenCalled();
  });

  test('a rejection with no message still reports the failure', async () => {
    const api = await import('./comments-client');
    const store = await import('./store');
    vi.mocked(api.deleteThread).mockRejectedValue(new Error(''));

    store.deleteThread('t1');

    await vi.waitFor(() => expect(toasted).toHaveLength(1));
    expect(toasted[0]).toMatch(/delete/i);
  });
});
