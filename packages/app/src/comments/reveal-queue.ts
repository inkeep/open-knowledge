import { requestDocPanelTab } from '@/components/doc-panel-events';
import type { PanelScope } from '@/components/PanelScopeHeader';
import { routeNoteWindowActionToMain } from '@/lib/note-window-main-actions';

const COMMENT_SCOPE_EVENT = 'open-knowledge:comments-scope';

const bus: EventTarget = typeof window === 'undefined' ? new EventTarget() : window;

let pendingScope: PanelScope | null = null;

export function consumePendingCommentScope(): PanelScope | null {
  const pending = pendingScope;
  pendingScope = null;
  return pending;
}

export function subscribeCommentScopeRequests(onRequest: (scope: PanelScope) => void): () => void {
  const handler = (event: Event): void => {
    pendingScope = null;
    onRequest((event as CustomEvent<PanelScope>).detail);
  };
  bus.addEventListener(COMMENT_SCOPE_EVENT, handler);
  return () => bus.removeEventListener(COMMENT_SCOPE_EVENT, handler);
}

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

export function revealQueue(docName?: string): void {
  revealComments('project', docName);
}
