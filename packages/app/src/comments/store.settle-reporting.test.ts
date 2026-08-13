/**
 * What a mutation reports, and what it must not.
 *
 * Every edit, delete, reopen and re-place ends in the same tail: refresh on
 * success, say so on failure. The failure message is the whole point of that
 * tail — a rejected edit used to look exactly like an accepted one — which
 * makes a FALSE failure the expensive bug here. The re-sync that follows a
 * successful mutation is a separate round trip over the same network, and
 * chained into the mutation's own rejection handler it made the edit that DID
 * land report itself as refused.
 */

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
    // The mutation landed; it is the re-sync behind it that cannot reach the
    // server. The panel is briefly stale, which the next CC1 signal corrects —
    // the one thing that must not happen is telling the reviewer their saved
    // edit was refused.
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
    // Re-synced anyway: a rejection can still have changed server state, and
    // leaving the stale row on screen would be a second, quieter lie.
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
