/**
 * Send the queue INTO the conversation already open, instead of starting one.
 *
 * The dispatch path always begins a fresh turn — a new agent thread, a new CLI
 * launch, a deep link. That is wrong when you have been working with an agent
 * and the comments are follow-up for it: the batch arrives detached from
 * everything already discussed.
 *
 * The reuse machinery already exists for the editor's Ask AI affordances.
 * `requestActiveTerminalInput` hands text to `TerminalSessionsHost`, which
 * writes it into the live session — a thread takes it as a staged composer
 * draft, a live CLI tab as a no-carriage-return write into its input — and only
 * launches something new when there is nothing to reuse.
 *
 * **The queue's own send leaves everything queued and unsent.** The human
 * presses enter, and this side cannot know whether the agent ever ran — marking
 * work done that nobody has acted on is the failure the queue exists to prevent.
 *
 * `resolve` opts out of that caution, for the one caller where it does not
 * apply: the selection composer's "Send to AI" writes a comment and hands it
 * over in a single gesture, so it was never a queued review item to begin with.
 * Leaving it open would put it in the batch the reviewer sends LATER, and they
 * would send the same note twice.
 */

import { requestActiveTerminalInput } from '@/components/handoff/terminal-input-events';
import { composeCommentBatchInstruction, toCommentBatchItem } from './comment-chips';
import { dispatchComments } from './store';

/**
 * Compose the checked queue and write it into the active session's input.
 * Returns how many comments were staged (0 when nothing was checked, the
 * prepare failed, or every thread had gone).
 *
 * Goes through `prepareDispatchBatch` rather than the local store: the server
 * re-anchors on prepare, so a passage that moved is reported as lost HERE, and
 * it is the only side that knows whether a quote repeats in its document — the
 * two facts that stop an agent editing the wrong passage.
 */
export async function appendQueueToOpenSession({
  sharedInstruction = '',
  threadIds,
  submit = false,
  resolve = false,
}: {
  sharedInstruction?: string;
  /**
   * Send exactly these instead of the checked queue.
   *
   * The composer's "Send to AI" hands over the ONE comment just written, which
   * is not in the checked set yet and must not drag the rest of the queue along
   * with it.
   */
  threadIds?: readonly string[];
  /**
   * Run it on a FRESH session instead of staging a draft there.
   *
   * Only reaches the fresh-launch fallback: reuse writes into a live input and
   * has never pressed enter, by design. So "Send to AI" with a chat already open
   * stages the batch for you to send, and with none open runs it — which is the
   * same asymmetry every other Ask AI surface has.
   */
  submit?: boolean;
  /**
   * Close the threads once handed over, instead of leaving them queued.
   *
   * Resolving is also what takes them OUT of the queue — the two are one state
   * change, so this cannot leave a thread resolved-but-still-listed.
   */
  resolve?: boolean;
} = {}): Promise<number> {
  // Routed through the ONE dispatch path rather than reimplementing it: that is
  // what gives this the re-entrancy guard (a second click used to start a second
  // hand-off), the re-anchor-on-prepare, and the single resolve call site. All
  // this contributes is WHERE the batch goes.
  const shipped = await dispatchComments({
    threadIds,
    resolve,
    compose: async (items) => {
      requestActiveTerminalInput(
        composeCommentBatchInstruction(
          items.map((item) => toCommentBatchItem(item.payload)),
          sharedInstruction,
        ),
        // `newTab: false` is the whole point — reuse the session you are in.
        { newTab: false, submit },
      );
      // The write into a live input is synchronous and unacknowledged; there is
      // nothing to fail. Reporting success is what lets `resolve` mean anything.
      return true;
    },
  });
  return shipped.length;
}
