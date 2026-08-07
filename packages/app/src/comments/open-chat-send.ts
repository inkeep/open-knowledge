/**
 * Sending a comment batch into the chat that is already open.
 *
 * The batch runs as a turn either way — this only routes it. A fresh thread is
 * started by the delivery hook; a LIVE thread has to be sent to from inside,
 * because that is where the machinery lives: the same path the composer's own
 * chip takes, so a batch sent from the panel and one sent from the chip are one
 * turn shape and one resolve rule. Writing the composed prose into that
 * thread's input instead left the reviewer to press enter on a wall of
 * generated text.
 *
 * Two hops rather than one, because neither end can do the other's half. The
 * panel knows a batch is ready but not which session is on screen or how to
 * reveal it; `SessionsHost` knows both but has no opinion about comments; and
 * every ThreadView stays mounted, so a broadcast with no thread id would fire
 * the batch from whichever thread answered first.
 */

const SEND_REQUEST_EVENT = 'open-knowledge:comments-send-to-open-chat';
const SEND_IN_THREAD_EVENT = 'open-knowledge:comments-send-in-thread';

// The node-env unit tier imports this module and has no `window` to listen on.
const bus: EventTarget = typeof window === 'undefined' ? new EventTarget() : window;

/**
 * The batch, carried by BOTH hops.
 *
 * `undefined` means the whole checked queue — what `dispatchComments` assumes
 * when told nothing. A scoped panel passes its own ids, and every hop has to
 * relay them: the This-doc footer counts one document's comments, so a channel
 * that dropped them on the way would send every checked comment in the project
 * from a button that had just promised four.
 */
export interface QueuedCommentBatch {
  readonly threadIds?: readonly string[];
}

/**
 * "Send these checked comments to whatever chat is open." Carries no
 * destination: the host resolves the active session, exactly as it does for a
 * reuse write. It does carry the batch.
 */
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

/** The host's answer: send THIS batch from THIS thread, now revealed and focused. */
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
