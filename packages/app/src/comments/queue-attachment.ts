/**
 * Attaching the comment queue to a composer that has no context-chip row.
 *
 * The Ask AI composer attaches the queue as context and composes it into the
 * prompt at send. An agent thread's composer is a plain string field, so this
 * gives it the same shape with the pieces it lacks: `prepareQueuedComments`
 * captures the batch when you switch it ON, and the composer folds it into the
 * message at send time with the draft as its leading instruction.
 *
 * Capturing at attach rather than at send is what keeps `submit` synchronous —
 * the composer's send is fire-and-forget today, and making it await a server
 * round-trip would open a double-send window it has no guard for. The cost is
 * that a comment queued AFTER you attach is not in the captured batch; toggle
 * off and on to re-capture.
 *
 * **Nothing resolves.** Attaching, and even sending, leaves every thread queued:
 * only a real dispatch may close a review request, and a thread's send does not
 * report whether the prompt landed.
 */

import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { type CommentBatchItem, toCommentBatchItem } from './comment-chips';
import * as api from './comments-client';
import { getSelectedQueue, refresh } from './store';

/**
 * Capture the checked queue as batch items, ready to compose into a message.
 * `null` when there is nothing to attach, so the caller stays detached.
 *
 * Goes through `prepareDispatchBatch` rather than reading the local store: the
 * server re-anchors on prepare, so a passage that moved is reported as lost
 * HERE, and it is the only side that knows whether a quote repeats in its
 * document — the two facts that stop an agent editing the wrong passage.
 */
export async function prepareQueuedComments(): Promise<CommentBatchItem[] | null> {
  const ids = getSelectedQueue();
  if (ids.length === 0) return null;

  let prepared: Awaited<ReturnType<typeof api.prepareDispatchBatch>>;
  try {
    prepared = await api.prepareDispatchBatch(ids);
  } catch {
    toast.error(t`Couldn't read the queued comments.`);
    return null;
  }

  const payloads = prepared.results.flatMap((item) => (item.ok ? [item.payload] : []));
  // Prepare re-anchors, which can flip a thread to orphaned; pull that in so the
  // queue reflects what was just captured.
  await refresh().catch(() => undefined);
  if (payloads.length === 0) return null;
  return payloads.map(toCommentBatchItem);
}
