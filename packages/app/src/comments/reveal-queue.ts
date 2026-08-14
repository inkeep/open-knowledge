/**
 * Bring the Comments tab on screen, at a named scope.
 *
 * Posting a comment is the moment the panel becomes relevant, and it is also
 * the moment its controls are easiest to miss: the composer's comments chip
 * only exists while the Ask AI bar is showing, and the bar is hidden whenever
 * the sessions dock is open. Without this, a reviewer can queue five comments
 * and never find the thing that sends them.
 *
 * The scope names what the caller is showing: a fresh post reveals "This doc" —
 * the comment you just made, beside the passage it is on — while the composer
 * chip reveals the project-wide queue, because the batch it counts spans
 * documents.
 *
 * Two steps, because the tab and the scope are owned by different components:
 * `requestDocPanelTab` opens the doc panel and selects the Comments tab
 * (`EditorArea` subscribes), and the scope event sets that tab's "This doc /
 * This project" toggle (`CommentsTab` subscribes, since it owns the toggle's
 * state).
 */

import { requestDocPanelTab } from '@/components/doc-panel-events';
import type { PanelScope } from '@/components/PanelScopeHeader';
import { routeNoteWindowActionToMain } from '@/lib/note-window-main-actions';

const COMMENT_SCOPE_EVENT = 'open-knowledge:comments-scope';

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
 * empty room and the tab opens on its default. Mirrors the pending-tab latch in
 * `doc-panel-events.ts`, which exists for the same reason: a live subscriber
 * clears it, and a component mounting afterwards consumes it instead.
 */
let pendingScope: PanelScope | null = null;

/** The scope of a reveal no live subscriber handled, once; null when none. */
export function consumePendingCommentScope(): PanelScope | null {
  const pending = pendingScope;
  pendingScope = null;
  return pending;
}

export function subscribeCommentScopeRequests(onRequest: (scope: PanelScope) => void): () => void {
  const handler = (event: Event): void => {
    // Handled live — don't also leave a latch for the next mount to trip on.
    pendingScope = null;
    onRequest((event as CustomEvent<PanelScope>).detail);
  };
  bus.addEventListener(COMMENT_SCOPE_EVENT, handler);
  return () => bus.removeEventListener(COMMENT_SCOPE_EVENT, handler);
}

/** Open the doc panel on the Comments tab, set to `scope`. */
export function revealComments(scope: PanelScope, docName?: string): void {
  if (
    docName !== undefined &&
    typeof window !== 'undefined' &&
    routeNoteWindowActionToMain(
      { kind: 'reveal-comments', docName, scope: scope === 'project' ? 'queue' : 'doc' },
      window,
    )
  )
    return;
  pendingScope = scope;
  requestDocPanelTab('comments');
  bus.dispatchEvent(new CustomEvent<PanelScope>(COMMENT_SCOPE_EVENT, { detail: scope }));
}

/** The project-wide queue — what the composer chip counts, spanning documents. */
export function revealQueue(docName?: string): void {
  revealComments('project', docName);
}
