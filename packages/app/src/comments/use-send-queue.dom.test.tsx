/**
 * Which half of the send runs, and — the part that broke — that the batch
 * survives the trip either way.
 *
 * Both halves send; only the destination differs. With no chat open the hook
 * dispatches a fresh turn itself; with one open it hands off to that thread.
 * The hand-off is where a scoped batch was lost: the closure took `threadIds`
 * and then called the request with no arguments, so a This-doc send arrived at
 * the thread as "no batch specified" and dispatched the whole project queue —
 * from a button whose count had just promised otherwise.
 */

import { render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const captured = {
  dispatched: [] as { threadIds?: readonly string[] }[],
  requested: [] as (readonly string[] | undefined)[],
};

let openSession: { kind: 'thread' | 'terminal' } | null = null;

vi.doMock('@/components/reusable-session-store', () => ({
  useReusableSession: () => openSession,
}));

vi.doMock('./store', () => ({
  dispatchComments: (args: { threadIds?: readonly string[] }) => {
    captured.dispatched.push(args);
    return Promise.resolve([]);
  },
}));

vi.doMock('./open-chat-send', () => ({
  requestSendToOpenChat: (threadIds?: readonly string[]) => captured.requested.push(threadIds),
}));

vi.doMock('./use-comment-delivery', () => ({
  useCommentDispatch: () => async () => true,
}));

afterEach(() => {
  captured.dispatched.length = 0;
  captured.requested.length = 0;
  openSession = null;
});

async function send(threadIds?: readonly string[]) {
  const { useSendQueue } = await import('./use-send-queue');
  function Probe() {
    const sendQueue = useSendQueue();
    // Called during render rather than from an effect: the hook returns a plain
    // closure, and this test is about what that closure forwards.
    sendQueue(threadIds);
    return null;
  }
  render(<Probe />);
}

describe('with no chat open', () => {
  test('dispatches a fresh turn carrying the batch', async () => {
    await send(['t1', 't2']);

    expect(captured.dispatched).toHaveLength(1);
    expect(captured.dispatched[0].threadIds).toEqual(['t1', 't2']);
    expect(captured.requested).toEqual([]);
  });
});

describe('with a chat open', () => {
  test('hands the batch to that thread rather than dispatching here', async () => {
    openSession = { kind: 'thread' };
    await send(['t1', 't2']);

    // The ids are the whole point of the hand-off: the thread has no other way
    // to know this was a scoped send.
    expect(captured.requested).toEqual([['t1', 't2']]);
    expect(captured.dispatched).toEqual([]);
  });

  test('an unscoped send stays unscoped across the hand-off', async () => {
    openSession = { kind: 'thread' };
    await send(undefined);

    // `undefined`, not `[]` — the thread reads that as "the whole checked
    // queue", which is what an unscoped send means.
    expect(captured.requested).toEqual([undefined]);
  });

  test('a live CLI tab is not a chat comments can go to', async () => {
    openSession = { kind: 'terminal' };
    await send(['t1']);

    // Comments never reach a terminal, so a CLI session falls through to the
    // fresh-turn path, which starts an in-app thread.
    expect(captured.dispatched[0]?.threadIds).toEqual(['t1']);
    expect(captured.requested).toEqual([]);
  });
});
