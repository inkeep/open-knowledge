/**
 * The one decision "send the queue" makes, shared by the panel's button and the
 * ⇧⌘Enter shortcut.
 *
 * Both halves SEND. Only the destination differs:
 *
 * - **No chat open** — start one and run the batch as its first turn.
 * - **A chat already open** — run it as the next turn THERE, from inside that
 *   thread, so it takes the same path the composer's own comment chip takes.
 *
 * Extracted rather than duplicated because a caller picking the wrong half would
 * either start a second conversation beside the one you are in, or send into a
 * thread that no longer exists.
 */

import { useReusableSession } from '@/components/reusable-session-store';
import { requestSendToOpenChat } from './open-chat-send';
import { dispatchComments } from './store';
import { useCommentDispatch } from './use-comment-delivery';

/**
 * `threadIds` narrows the batch to what one panel is showing — the This-doc
 * scope sends the checked comments on the open file only. Omitted (the ⇧⌘Enter
 * path) it means the whole checked queue, project-wide.
 */
export function useSendQueue(): (threadIds?: readonly string[]) => void {
  const composeFreshTurn = useCommentDispatch();
  const openSession = useReusableSession();
  // Only an in-app thread counts as reusable. The dock also publishes a live CLI
  // tab, and appending there wrote a comment batch into the terminal — the same
  // trip to the terminal a fresh turn no longer takes. With a CLI open this
  // falls through to the fresh-turn path, which starts a thread.
  const reusableThread = openSession?.kind === 'thread' ? openSession : null;
  return (threadIds) => {
    if (reusableThread === null) {
      void dispatchComments({ compose: composeFreshTurn, threadIds });
      return;
    }
    // Nothing to prepare or compose here: the thread sends it, because that is
    // where the batch's turn shape and resolve rule already live. Anything typed
    // in that composer rides along as the batch's shared instruction rather than
    // being cleared — you were mid-sentence, and the comments join it.
    //
    // `threadIds` travels with it. Dropped, a This-doc send would arrive at the
    // thread as "no batch specified" and dispatch the whole project queue — from
    // a button whose count had just said otherwise.
    requestSendToOpenChat(threadIds);
  };
}
