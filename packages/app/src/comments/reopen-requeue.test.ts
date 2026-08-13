/**
 * Reopening puts a comment back in the batch.
 *
 * A send clears `queued` on its way to `resolved`, and reopening is the
 * correction for a send that did not settle the thing — so the server reopens it
 * queued and the next send carries it without a second click.
 *
 * The case worth pinning is the one the server cannot see. "Checked" is `queued`
 * minus a LOCAL unticked set, so a comment the reviewer unticked before it went
 * out still has its veto recorded here. Left in place, the server would report
 * queued while the panel rendered unchecked — exactly the second click reopening
 * exists to avoid, and with nothing on screen explaining it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CommentThreadMeta } from './comments-client';

function meta(threadId: string, queued: boolean, state: CommentThreadMeta['state']) {
  return {
    threadId,
    docName: 'notes/rollout',
    target: { kind: 'body' } as const,
    anchor: { exact: `quote ${threadId}`, prefix: '', suffix: '', start: 0, end: 5 },
    state,
    queued,
    latestComment: 'still true?',
    createdBy: 'principal-abc',
    createdAt: 1000,
  } satisfies CommentThreadMeta;
}

let corpus: CommentThreadMeta[];

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

vi.mock('./comments-client', () => ({
  listThreads: vi.fn(async () => corpus),
  queueThread: vi.fn(async (threadId: string) => {
    const found = corpus.find((m) => m.threadId === threadId);
    if (found) found.queued = true;
    return { meta: found, orphaned: false };
  }),
  unqueueThread: vi.fn(async (threadId: string) => {
    const found = corpus.find((m) => m.threadId === threadId);
    if (found) found.queued = false;
    return found;
  }),
  // The server's contract: reopening comes back anchored AND queued.
  reopenThread: vi.fn(async (threadId: string) => {
    const found = corpus.find((m) => m.threadId === threadId);
    if (found) {
      found.state = 'anchored';
      found.queued = true;
    }
    return found;
  }),
  createThread: vi.fn(),
  reply: vi.fn(),
  replaceAnchor: vi.fn(),
  deleteThread: vi.fn(),
  editComment: vi.fn(),
  prepareDispatchBatch: vi.fn(),
  completeDispatchBatch: vi.fn(),
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  corpus = [meta('t1', true, 'anchored'), meta('t2', false, 'resolved')];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('reopenThread', () => {
  test('a reopened comment lands checked', async () => {
    const store = await import('./store');
    await store.refresh();
    expect(store.getSelectedQueue()).toEqual(['t1']);

    store.reopenThread('t2');
    await settle();

    expect(store.getSelectedQueue()).toContain('t2');
  });

  test('an untick recorded before the send does not survive the reopen', async () => {
    const store = await import('./store');
    await store.refresh();

    // Untick it while it is still open, then send it and reopen it. The local
    // veto is what would otherwise outlive the round trip.
    store.toggleSending('t1');
    await settle();
    expect(store.getSelectedQueue()).not.toContain('t1');

    const found = corpus.find((m) => m.threadId === 't1');
    if (found) found.state = 'resolved';
    await store.refresh();

    store.reopenThread('t1');
    await settle();

    expect(store.getSelectedQueue()).toContain('t1');
  });

  test('reopening one comment leaves the rest of the batch alone', async () => {
    const store = await import('./store');
    await store.refresh();

    store.reopenThread('t2');
    await settle();

    expect([...store.getSelectedQueue()].sort()).toEqual(['t1', 't2']);
  });
});
