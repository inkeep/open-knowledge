/**
 * Posting a comment reveals the Comments tab — but only once the server has
 * taken it, and on THIS DOC's scope: the thing to show is the comment just
 * made, beside its passage, not the project-wide queue.
 *
 * The reveal is what tells a first-time reviewer the panel exists and where the
 * send lives, so it has to fire on a real post. Equally, it must NOT fire on a
 * rejected one: opening the panel for a comment that failed to anchor reads as
 * "your comment went somewhere", which is worse than no reveal at all.
 */

import { describe, expect, test, vi } from 'vitest';

const META = {
  threadId: 't1',
  docName: 'recipes/stir-fry',
  anchor: { exact: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
  state: 'anchored',
  queued: true,
  createdBy: 'principal-abc',
  createdAt: 1000,
};

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

vi.mock('./comments-client', () => ({
  listThreads: vi.fn(async () => []),
  createThread: vi.fn(async () => META),
  reply: vi.fn(),
  reopenThread: vi.fn(),
  replaceAnchor: vi.fn(),
  queueThread: vi.fn(),
  unqueueThread: vi.fn(),
  deleteThread: vi.fn(),
  prepareDispatchBatch: vi.fn(),
  completeDispatchBatch: vi.fn(),
}));

/** Let the store's fire-and-forget promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Subscribe through the SAME module instance the store will publish on.
 * `vi.resetModules()` gives each test a fresh registry, and the event bus is
 * module state — a statically imported subscriber would listen on the previous
 * instance's bus and never hear a thing.
 */
async function watchReveals(): Promise<{
  count: () => number;
  scopes: string[];
  stop: () => void;
}> {
  const { subscribeCommentScopeRequests } = await import('./reveal-queue');
  let seen = 0;
  const scopes: string[] = [];
  const stop = subscribeCommentScopeRequests((scope) => {
    seen += 1;
    scopes.push(scope);
  });
  return { count: () => seen, scopes, stop };
}

describe('createThread reveals the Comments tab', () => {
  test('fires once the server accepts the comment, on doc scope', async () => {
    vi.resetModules();
    const store = await import('./store');
    const reveals = await watchReveals();

    store.createThread({ docName: 'recipes/stir-fry', quote: 'the tofu', body: 'press it?' });
    await settle();

    expect(reveals.count()).toBe(1);
    // This doc, not the project queue: the thing to show is the comment just
    // made, beside the passage it is on.
    expect(reveals.scopes).toEqual(['doc']);
    reveals.stop();
  });

  test('stays put when the post is rejected', async () => {
    vi.resetModules();
    const api = await import('./comments-client');
    vi.mocked(api.createThread).mockRejectedValueOnce(new Error('passage not found'));
    const store = await import('./store');
    const reveals = await watchReveals();

    store.createThread({ docName: 'recipes/stir-fry', quote: 'gone', body: 'x' });
    await settle();

    expect(reveals.count()).toBe(0);
    // and the failure is surfaced rather than swallowed
    const { toast } = await import('sonner');
    expect(vi.mocked(toast.error)).toHaveBeenCalled();
    reveals.stop();
  });
});

describe('a reveal nobody was listening for', () => {
  // The reported bug: a reveal opened the Comments tab but its scope request
  // was dropped. Opening the tab only SCHEDULES a mount, so when the tab wasn't
  // already showing there was no subscriber when the scope event fired. The
  // earlier tests missed it by always subscribing first, which is the one case
  // that already worked.
  test('is latched, with its scope, for the component about to mount', async () => {
    vi.resetModules();
    const { revealQueue, consumePendingCommentScope } = await import('./reveal-queue');

    revealQueue(); // nothing subscribed — exactly the tab-was-closed case

    expect(consumePendingCommentScope()).toBe('project');
    // and only once: a later mount must not re-jump the scope
    expect(consumePendingCommentScope()).toBeNull();
  });

  test('a live subscriber clears the latch instead of leaving it armed', async () => {
    vi.resetModules();
    const { revealComments, consumePendingCommentScope, subscribeCommentScopeRequests } =
      await import('./reveal-queue');
    const heard: string[] = [];
    const stop = subscribeCommentScopeRequests((scope) => heard.push(scope));

    revealComments('doc');

    expect(heard).toEqual(['doc']);
    // Already delivered — a tab mounted later must NOT have its scope yanked.
    expect(consumePendingCommentScope()).toBeNull();
    stop();
  });

  test('nothing is latched until a reveal actually fires', async () => {
    vi.resetModules();
    const { consumePendingCommentScope } = await import('./reveal-queue');
    expect(consumePendingCommentScope()).toBeNull();
  });
});
