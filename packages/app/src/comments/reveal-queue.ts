/**
 * Bring the dispatch queue on screen.
 *
 * Posting a comment is the moment the queue becomes relevant, and it is also
 * the moment the send control is easiest to miss: the composer's comments chip
 * only exists while the Ask AI bar is showing, and the bar is hidden whenever
 * the sessions dock is open. Without this, a reviewer can queue five comments
 * and never find the thing that sends them.
 *
 * Two steps, because the tab and the scope are owned by different components:
 * `requestDocPanelTab` opens the doc panel and selects the Comments tab
 * (`EditorArea` subscribes), and the scope event flips that tab from "This doc"
 * to "Queue" (`CommentsTab` subscribes, since it owns the toggle's state).
 */

import { requestDocPanelTab } from '@/components/doc-panel-events';

const QUEUE_SCOPE_EVENT = 'open-knowledge:comments-queue-scope';

// `createThread` reaches this from the store, which the node-env unit tier
// imports — where there is no `window`. One module-level stand-in (rather than
// the sibling event modules' per-call default) so subscribe and dispatch still
// meet on the same target instead of silently passing each other.
const bus: EventTarget = typeof window === 'undefined' ? new EventTarget() : window;

/**
 * Latch for the reveal that arrives before anyone can hear it.
 *
 * Opening the Comments tab only SCHEDULES a React state change, so when the
 * tab wasn't already open `CommentsTab` has not mounted — and has not
 * subscribed — by the time the scope event goes out. The event lands on an
 * empty room and the tab opens on "This doc". Mirrors the pending-tab latch in
 * `doc-panel-events.ts`, which exists for the same reason: a live subscriber
 * clears it, and a component mounting afterwards consumes it instead.
 */
let pendingQueueScope = false;

/** True once per reveal that no live subscriber handled. */
export function consumePendingQueueScope(): boolean {
  const pending = pendingQueueScope;
  pendingQueueScope = false;
  return pending;
}

export function subscribeQueueScopeRequests(onRequest: () => void): () => void {
  const handler = (): void => {
    // Handled live — don't also leave a latch for the next mount to trip on.
    pendingQueueScope = false;
    onRequest();
  };
  bus.addEventListener(QUEUE_SCOPE_EVENT, handler);
  return () => bus.removeEventListener(QUEUE_SCOPE_EVENT, handler);
}

/** Open the doc panel on the Comments tab, scoped to the queue. */
export function revealQueue(): void {
  pendingQueueScope = true;
  requestDocPanelTab('comments');
  bus.dispatchEvent(new Event(QUEUE_SCOPE_EVENT));
}
