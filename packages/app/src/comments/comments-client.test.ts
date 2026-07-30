/**
 * The client validates what the server sends.
 *
 * This file used to restate the thread shape by hand and cast responses to it,
 * so a server-side field the client had not been taught about arrived as
 * `undefined` and surfaced somewhere far away — a blank card, a crash in a
 * renderer. It now parses against the shared schema, and these pin the two
 * dispositions that choice implies.
 */

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
    // Skipping rather than throwing mirrors the store on the server side, where
    // an unreadable thread file is skipped instead of being fatal. One bad
    // thread must not blank the panel for every healthy one.
    respond({ threads: [healthy, { threadId: 'nope' }, { ...healthy, docName: 'notes/other' }] });

    const threads = await listThreads();
    expect(threads.map((t) => t.docName)).toEqual(['notes/rollout', 'notes/other']);
  });

  test('applies the schema defaults rather than leaving holes', async () => {
    // `target` is absent here. The schema defaults it to `body`, which is why
    // the store can read `meta.target` directly instead of re-deriving it.
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
    // The caller asked for one specific thread; an unparseable one means the
    // result is unknown. Returning it anyway would move the failure far from
    // its cause.
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
    // `queueThread` wraps the thread in `{ meta, orphaned }`. The wrapper used to
    // be cast wholesale, so a malformed `meta` rode straight through.
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
    // One stale id must be reported in place, not fail the batch — the ids were
    // chosen earlier and one going missing cannot take the rest down.
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
