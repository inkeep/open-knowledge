const SEND_REQUEST_EVENT = 'open-knowledge:comments-send-to-open-chat';
const SEND_IN_THREAD_EVENT = 'open-knowledge:comments-send-in-thread';

const bus: EventTarget = typeof window === 'undefined' ? new EventTarget() : window;

export interface QueuedCommentBatch {
  readonly threadIds?: readonly string[];
}

export function requestSendToOpenChat(threadIds?: readonly string[]): void {
  bus.dispatchEvent(
    new CustomEvent<QueuedCommentBatch>(SEND_REQUEST_EVENT, { detail: { threadIds } }),
  );
}

export function subscribeSendToOpenChat(
  onRequest: (batch: QueuedCommentBatch) => void,
): () => void {
  const handler = (event: Event): void => {
    onRequest(event instanceof CustomEvent ? ((event.detail as QueuedCommentBatch) ?? {}) : {});
  };
  bus.addEventListener(SEND_REQUEST_EVENT, handler);
  return () => bus.removeEventListener(SEND_REQUEST_EVENT, handler);
}

interface SendInThreadDetail extends QueuedCommentBatch {
  readonly threadId: string;
}

export function sendQueuedCommentsInThread(threadId: string, threadIds?: readonly string[]): void {
  bus.dispatchEvent(
    new CustomEvent<SendInThreadDetail>(SEND_IN_THREAD_EVENT, { detail: { threadId, threadIds } }),
  );
}

export function subscribeSendInThread(
  onSend: (threadId: string, threadIds?: readonly string[]) => void,
): () => void {
  const handler = (event: Event): void => {
    const detail = event instanceof CustomEvent ? (event.detail as SendInThreadDetail) : null;
    if (detail == null || typeof detail.threadId !== 'string' || detail.threadId === '') return;
    onSend(detail.threadId, detail.threadIds);
  };
  bus.addEventListener(SEND_IN_THREAD_EVENT, handler);
  return () => bus.removeEventListener(SEND_IN_THREAD_EVENT, handler);
}
