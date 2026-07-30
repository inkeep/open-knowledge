/**
 * Comments tab shell — one tab with a "This doc / Queue" scope toggle, reusing
 * the header Problems uses for per-doc vs. project scope (PanelScopeHeader).
 * "This doc" shows the current document's threads; "Queue" shows the batch
 * waiting to be sent, which spans every file.
 */

import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { type PanelScope, PanelScopeHeader } from '@/components/PanelScopeHeader';
import { CommentQueuePanel } from './CommentQueuePanel';
import { CommentsPanel } from './CommentsPanel';
import { consumePendingQueueScope, subscribeQueueScopeRequests } from './reveal-queue';

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
  return (
    <div className="flex h-full min-h-0 flex-col pt-2">
      {/* "Queue", not "Project": this side isn't every comment in the project,
          it's the batch waiting to be sent. */}
      <PanelScopeHeader scope={scope} onScopeChange={setScope} projectLabel={t`Queue`} />
      <div className="min-h-0 flex-1">
        {scope === 'doc' ? <CommentsPanel docName={docName} /> : <CommentQueuePanel />}
      </div>
    </div>
  );
}
