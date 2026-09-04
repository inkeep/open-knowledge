import { afterEach, describe, expect, test, vi } from 'vitest';
import { completeDispatchBatch, createThread, listThreads, queueThread } from './comments-client';

function respond(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response),
  );
}

const healthy = {
  threadId: '11111111-1111-4111-8111-111111111111',
  docName: 'notes/rollout',
  target: { kind: 'body' },
  anchor: { exact: 'minimal downtime', prefix: '', suffix: '', start: 0, end: 16 },
  state: 'anchored',
  queued: true,
  latestComment: 'still accurate?',
  createdBy: 'principal-abc',
  createdAt: 1000,
};

afterEach(() => vi.unstubAllGlobals());

describe('listThreads', () => {
  test('drops a thread it cannot read and keeps the rest', async () => {
    respond({ threads: [healthy, { threadId: 'nope' }, { ...healthy, docName: 'notes/other' }] });

    const threads = await listThreads();
    expect(threads.map((t) => t.docName)).toEqual(['notes/rollout', 'notes/other']);
  });

  test('applies the schema defaults rather than leaving holes', async () => {
    const withoutTarget: Record<string, unknown> = { ...healthy };
    delete withoutTarget.target;
    respond({ threads: [withoutTarget] });

    const [thread] = await listThreads();
    expect(thread.target).toEqual({ kind: 'body' });
  });

  test('a property target keeps its path', async () => {
    respond({
      threads: [{ ...healthy, target: { kind: 'property', key: 'tags', path: [2] }, anchor: null }],
    });

    const [thread] = await listThreads();
    expect(thread.target).toEqual({ kind: 'property', key: 'tags', path: [2] });
    expect(thread.anchor).toBeNull();
  });
});

describe('a single-thread response', () => {
  test('rejects rather than handing back a malformed thread', async () => {
    respond({ threadId: 'nope' });

    await expect(createThread({ docName: 'notes/rollout', quote: 'x', body: 'y' })).rejects.toThrow(
      /cannot read/,
    );
  });

  test('returns the thread when it parses', async () => {
    respond(healthy);

    const meta = await createThread({ docName: 'notes/rollout', quote: 'x', body: 'y' });
    expect(meta.threadId).toBe(healthy.threadId);
  });
});

describe('envelope responses', () => {
  test('a queue response with an unreadable thread is rejected', async () => {
    respond({ meta: { threadId: 'nope' }, orphaned: false });

    await expect(queueThread(healthy.threadId)).rejects.toThrow(/cannot read/);
  });

  test('a well-formed queue response comes back parsed', async () => {
    respond({ meta: healthy, orphaned: true });

    const result = await queueThread(healthy.threadId);
    expect(result.orphaned).toBe(true);
    expect(result.meta.docName).toBe('notes/rollout');
  });

  test('a batch keeps its per-item not-found entries', async () => {
    respond({
      results: [
        { threadId: healthy.threadId, ok: true, meta: healthy },
        { threadId: '22222222-2222-4222-8222-222222222222', ok: false, error: 'not-found' },
      ],
    });

    const { results } = await completeDispatchBatch([healthy.threadId]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
  });

  test('a batch carrying a malformed thread is rejected', async () => {
    respond({ results: [{ threadId: healthy.threadId, ok: true, meta: { threadId: 'nope' } }] });

    await expect(completeDispatchBatch([healthy.threadId])).rejects.toThrow(/cannot read/);
  });
});
