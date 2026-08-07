/**
 * The channel between the Comments panel, the sessions host, and the one thread
 * that sends the batch.
 *
 * Two hops rather than one, and the second one is keyed. Every ThreadView stays
 * mounted, so a broadcast carrying no thread id would fire the batch from every
 * open conversation at once.
 */

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
    // An unscoped send means the whole checked queue, which is what
    // `dispatchComments` assumes when told nothing.
    expect(onRequest).toHaveBeenCalledWith({ threadIds: undefined });
  });

  test('carries the batch when the panel scoped one', () => {
    const onRequest = vi.fn();
    track(subscribeSendToOpenChat(onRequest));

    requestSendToOpenChat(['t1', 't2']);

    // The This-doc footer counts one document's comments. Dropping the ids here
    // would land at the thread as "no batch specified" and send every checked
    // comment in the project, from a button that had just promised two.
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

    // The subscriber filters on its own id; what matters here is that the id
    // travels at all, since without it every mounted thread would send.
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

    // `undefined`, never `[]`: an empty array is a batch of nothing, which
    // `dispatchComments` would treat as a no-op instead of the whole queue.
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
