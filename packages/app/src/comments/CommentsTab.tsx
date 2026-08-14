/**
 * Comments tab shell — one tab with a "This doc / This project" scope toggle,
 * reusing the header Problems uses for per-doc vs. project scope
 * (PanelScopeHeader). Both sides render the same list; the scope only widens the
 * set from the open document to every file.
 *
 * The tab owns the scope but not where the switch is DRAWN: it hands the element
 * to the panel, which renders it under its own title.
 */

import { useEffect, useState } from 'react';
import { type PanelScope, PanelScopeHeader } from '@/components/PanelScopeHeader';
import { useSingleFileMode } from '@/lib/single-file-mode';
import { CommentProjectPanel } from './CommentProjectPanel';
import { CommentsPanel } from './CommentsPanel';
import { consumePendingCommentScope, subscribeCommentScopeRequests } from './reveal-queue';
import { setVisibleCommentScope } from './visible-scope';

export function CommentsTab({ docName }: { docName: string }) {
  const [requestedScope, setRequestedScope] = useState<PanelScope>('doc');
  // A `ok <file>` session has no project to widen to — the one document IS the
  // whole of it. So the scope is pinned to "This doc" and the switch is not
  // drawn, rather than offering a second view of the same list under a name
  // that promises files the session cannot reach.
  const singleFile = useSingleFileMode();
  const scope: PanelScope = singleFile ? 'doc' : requestedScope;
  // Reveals set this tab's scope from outside — posting a comment lands on
  // "This doc" (the comment you just made, beside its passage), the composer
  // chip on "This project" (its batch spans documents). The scope lives here, so
  // a reveal reaches it through an event rather than a prop; the pending check
  // covers the mount the reveal itself caused, which fires its event before
  // this component exists to hear it.
  useEffect(() => {
    const pending = consumePendingCommentScope();
    if (pending !== null) setRequestedScope(pending);
    return subscribeCommentScopeRequests(setRequestedScope);
  }, []);
  // Publish what is on screen so ⇧⌘Enter sends the batch the visible button
  // would. Cleared on unmount — this tab is conditionally rendered, so leaving a
  // stale scope behind would have the chord scoping to a panel that closed.
  useEffect(() => {
    setVisibleCommentScope({ scope, docName });
    return () => setVisibleCommentScope(null);
  }, [scope, docName]);
  // The panel is returned bare, with no wrapper of its own: every sibling tab
  // (Outline, Links, Problems) hands its `Panel` straight to the tab-panel
  // container, and a wrapper that added even a few pixels of top padding here
  // shifted the whole Comments panel down and made it that much shorter than
  // the others — visible as a jump when switching tabs.
  //
  // The scope switch is handed DOWN into the panel rather than rendered here,
  // so it lands under the panel's own "Comments" title — the order Problems
  // already uses. Rendered above it, the switch read as tab-strip chrome and
  // the title looked like a heading for the list alone.
  // No `projectLabel`: "This project" is the shared default now, so both
  // panels say it without either one restating it.
  const scopeSwitch = singleFile ? undefined : (
    <PanelScopeHeader scope={scope} onScopeChange={setRequestedScope} />
  );
  return scope === 'doc' ? (
    <CommentsPanel docName={docName} scopeSwitch={scopeSwitch} />
  ) : (
    <CommentProjectPanel scopeSwitch={scopeSwitch} />
  );
}
