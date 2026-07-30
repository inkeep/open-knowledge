/**
 * Capturing the queue for a composer that attaches it.
 *
 * The batch is captured when the `+` menu's Queue toggle goes ON, and composed
 * into the message at send. Two properties matter: every checked comment is in
 * the capture (a partial batch silently drops someone's review), and capturing
 * resolves nothing — attaching is not dispatching, and closing a request nobody
 * acted on is the failure the queue exists to prevent.
 */

import { describe, expect, test, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

vi.mock('./comments-client', () => {
  const metas = [
    {
      threadId: 't1',
      docName: 'recipes/one',
      anchor: { exact: 'Heat oven to 425F', prefix: '', suffix: '', start: 0, end: 17 },
      state: 'anchored',
      queued: true,
      latestComment: 'too hot?',
      createdBy: 'principal-abc',
      createdAt: 800,
    },
    {
      threadId: 't2',
      docName: 'recipes/two',
      anchor: { exact: 'Whisk the peanut sauce', prefix: '', suffix: '', start: 0, end: 22 },
      state: 'anchored',
      queued: true,
      latestComment: 'which peanut butter?',
      createdBy: 'principal-abc',
      createdAt: 900,
    },
  ];
  return {
    __metas: metas,
    listThreads: vi.fn(async () => metas),
    createThread: vi.fn(),
    reply: vi.fn(),
    resolveThread: vi.fn(),
    reopenThread: vi.fn(),
    replaceAnchor: vi.fn(),
    queueThread: vi.fn(),
    unqueueThread: vi.fn(),
    deleteThread: vi.fn(),
    prepareDispatchBatch: vi.fn(async (ids: readonly string[]) => ({
      results: ids.map((id) => {
        const m = metas.find((entry) => entry.threadId === id);
        if (!m) return { threadId: id, ok: false, error: 'not-found' };
        return {
          threadId: id,
          ok: true,
          meta: m,
          payload: {
            docName: m.docName,
            instruction: m.latestComment,
            passage: { exact: m.anchor.exact, prefix: '', suffix: '' },
            anchorLost: false,
            passageRepeats: false,
          },
        };
      }),
    })),
    completeDispatchBatch: vi.fn(async () => ({ results: [] })),
  };
});

describe('prepareQueuedComments', () => {
  test('captures every checked comment with its doc and passage', async () => {
    vi.resetModules();
    const store = await import('./store');
    await store.refresh();
    expect(store.getSelectedQueue()).toHaveLength(2);

    const { prepareQueuedComments } = await import('./queue-attachment');
    const items = await prepareQueuedComments();

    expect(items).toHaveLength(2);
    expect(items?.map((i) => i.body)).toEqual(['too hot?', 'which peanut butter?']);
    // A batch spans documents, so each item names its own — attributing a
    // comment to the wrong file is what the per-item `docName` prevents.
    expect(items?.map((i) => i.docName)).toEqual(['recipes/one', 'recipes/two']);
    expect(items?.map((i) => i.quote)).toEqual(['Heat oven to 425F', 'Whisk the peanut sauce']);
  });

  test('composes into a message with the draft leading', async () => {
    // The typed words frame the comments; the composer holds only those words
    // while you write, and this is where the two are joined.
    vi.resetModules();
    const store = await import('./store');
    await store.refresh();

    const { prepareQueuedComments } = await import('./queue-attachment');
    const { composeCommentBatchInstruction } = await import('./comment-chips');
    const items = await prepareQueuedComments();
    const text = composeCommentBatchInstruction(items ?? [], 'Keep the voice consistent.');

    expect(text.startsWith('Keep the voice consistent.')).toBe(true);
    expect(text).toContain('too hot?');
    expect(text).toContain('which peanut butter?');
  });

  test('resolves nothing — attaching is not dispatching', async () => {
    vi.resetModules();
    const store = await import('./store');
    await store.refresh();

    const { prepareQueuedComments } = await import('./queue-attachment');
    await prepareQueuedComments();

    const api = await import('./comments-client');
    expect(api.completeDispatchBatch).not.toHaveBeenCalled();
    // Still queued and still checked — nothing has been sent yet, and the Ask
    // AI composer's Send must still be able to carry them.
    expect(store.getSelectedQueue()).toHaveLength(2);
  });

  test('an empty queue captures nothing, so the toggle stays off', async () => {
    vi.resetModules();
    const { prepareQueuedComments } = await import('./queue-attachment');
    // No `refresh()`, so the store's queue is empty.
    expect(await prepareQueuedComments()).toBeNull();
  });
});
