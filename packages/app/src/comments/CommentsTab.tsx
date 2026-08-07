/**
 * Comments tab shell — one tab with a "This doc / This project" scope toggle,
 * reusing the header Problems uses for per-doc vs. project scope
 * (PanelScopeHeader). Both sides render the same list; the scope only widens the
 * set from the open document to every file.
 */

import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { type PanelScope, PanelScopeHeader } from '@/components/PanelScopeHeader';
import { CommentProjectPanel } from './CommentProjectPanel';
import { CommentsPanel } from './CommentsPanel';
import { consumePendingQueueScope, subscribeQueueScopeRequests } from './reveal-queue';
import { setVisibleCommentScope } from './visible-scope';

export function CommentsTab({ docName }: { docName: string }) {
  const { t } = useLingui();
  const [scope, setScope] = useState<PanelScope>('doc');
  // Posting a comment flips this tab to the queue — the scope lives here, so the
  // reveal has to reach it through an event rather than a prop. The pending
  // check covers the mount the reveal itself caused, which fires its event
  // before this component exists to hear it.
  useEffect(() => {
    if (consumePendingQueueScope()) setScope('project');
    return subscribeQueueScopeRequests(() => setScope('project'));
  }, []);
  // Publish what is on screen so ⇧⌘Enter sends the batch the visible button
  // would. Cleared on unmount — this tab is conditionally rendered, so leaving a
  // stale scope behind would have the chord scoping to a panel that closed.
  useEffect(() => {
    setVisibleCommentScope({ scope, docName });
    return () => setVisibleCommentScope(null);
  }, [scope, docName]);
  return (
    <div className="flex h-full min-h-0 flex-col pt-2">
      {/* "This project" rather than Problems' bare "Project", so the two sides
          read as one pair — the same list, this file or all of them. */}
      <PanelScopeHeader scope={scope} onScopeChange={setScope} projectLabel={t`This project`} />
      <div className="min-h-0 flex-1">
        {scope === 'doc' ? <CommentsPanel docName={docName} /> : <CommentProjectPanel />}
      </div>
    </div>
  );
}
