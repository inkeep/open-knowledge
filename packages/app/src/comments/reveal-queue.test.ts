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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    const { toast } = await import('sonner');
    expect(vi.mocked(toast.error)).toHaveBeenCalled();
    reveals.stop();
  });
});

describe('a reveal nobody was listening for', () => {
  test('is latched, with its scope, for the component about to mount', async () => {
    vi.resetModules();
    const { revealQueue, consumePendingCommentScope } = await import('./reveal-queue');

    revealQueue();

    expect(consumePendingCommentScope()).toBe('project');
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
    expect(consumePendingCommentScope()).toBeNull();
    stop();
  });

  test('nothing is latched until a reveal actually fires', async () => {
    vi.resetModules();
    const { consumePendingCommentScope } = await import('./reveal-queue');
    expect(consumePendingCommentScope()).toBeNull();
  });
});
