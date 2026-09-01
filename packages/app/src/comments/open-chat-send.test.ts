import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  requestSendToOpenChat,
  sendQueuedCommentsInThread,
  subscribeSendInThread,
  subscribeSendToOpenChat,
} from './open-chat-send';

const stops: (() => void)[] = [];

function track(stop: () => void): () => void {
  stops.push(stop);
  return stop;
}

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('the send request', () => {
  test('carries no destination — the host resolves which session is open', () => {
    const onRequest = vi.fn();
    track(subscribeSendToOpenChat(onRequest));

    requestSendToOpenChat();

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest).toHaveBeenCalledWith({ threadIds: undefined });
  });

  test('carries the batch when the panel scoped one', () => {
    const onRequest = vi.fn();
    track(subscribeSendToOpenChat(onRequest));

    requestSendToOpenChat(['t1', 't2']);

    expect(onRequest).toHaveBeenCalledWith({ threadIds: ['t1', 't2'] });
  });

  test('stops firing once unsubscribed', () => {
    const onRequest = vi.fn();
    subscribeSendToOpenChat(onRequest)();

    requestSendToOpenChat();

    expect(onRequest).not.toHaveBeenCalled();
  });
});

describe('the send-in-thread answer', () => {
  test('reaches only the thread it names', () => {
    const sentFrom: string[] = [];
    track(subscribeSendInThread((threadId) => sentFrom.push(threadId)));

    sendQueuedCommentsInThread('thread-a');

    expect(sentFrom).toEqual(['thread-a']);
  });

  test('carries the batch to that thread, not just the address', () => {
    const calls: { threadId: string; threadIds?: readonly string[] }[] = [];
    track(subscribeSendInThread((threadId, threadIds) => calls.push({ threadId, threadIds })));

    sendQueuedCommentsInThread('thread-a', ['t1', 't2']);

    expect(calls).toEqual([{ threadId: 'thread-a', threadIds: ['t1', 't2'] }]);
  });

  test('an unscoped send arrives unscoped rather than empty', () => {
    const calls: (readonly string[] | undefined)[] = [];
    track(subscribeSendInThread((_threadId, threadIds) => calls.push(threadIds)));

    sendQueuedCommentsInThread('thread-a');

    expect(calls).toEqual([undefined]);
  });

  test('ignores an empty id rather than sending from nothing', () => {
    const sentFrom: string[] = [];
    track(subscribeSendInThread((threadId) => sentFrom.push(threadId)));

    sendQueuedCommentsInThread('');

    expect(sentFrom).toEqual([]);
  });

  test('the two channels do not answer each other', () => {
    const onRequest = vi.fn();
    const onSendInThread = vi.fn();
    track(subscribeSendToOpenChat(onRequest));
    track(subscribeSendInThread(onSendInThread));

    requestSendToOpenChat();
    expect(onSendInThread).not.toHaveBeenCalled();

    sendQueuedCommentsInThread('thread-a');
    expect(onRequest).toHaveBeenCalledTimes(1);
  });
});
