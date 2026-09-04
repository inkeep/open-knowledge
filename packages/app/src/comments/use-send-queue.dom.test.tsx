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

    expect(captured.requested).toEqual([['t1', 't2']]);
    expect(captured.dispatched).toEqual([]);
  });

  test('an unscoped send stays unscoped across the hand-off', async () => {
    openSession = { kind: 'thread' };
    await send(undefined);

    expect(captured.requested).toEqual([undefined]);
  });

  test('a live CLI tab is not a chat comments can go to', async () => {
    openSession = { kind: 'terminal' };
    await send(['t1']);

    expect(captured.dispatched[0]?.threadIds).toEqual(['t1']);
    expect(captured.requested).toEqual([]);
  });
});
