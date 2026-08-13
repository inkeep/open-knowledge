/**
 * The "This doc" comment scope: every thread on the open document.
 *
 * The list, header, ticks and send footer are shared with the "This project"
 * scope (see CommentListPanel) — all this side decides is which threads arrive
 * and that they need no filename headings, there being one file.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { ProfilerBoundary } from '@/lib/perf';
import { CommentListPanel } from './CommentListPanel';
import { refresh, useCommentThreads } from './store';

function CommentsPanelInner({
  docName,
  scopeSwitch,
}: {
  docName: string;
  scopeSwitch?: ReactNode;
}) {
  const threads = useCommentThreads(docName);

  // Load this doc's threads when the panel opens — it can open before (or
  // without) the editor's anchor layer having mounted.
  useEffect(() => {
    void refresh(docName).catch(() => undefined);
  }, [docName]);

  return (
    <CommentListPanel
      threads={threads}
      empty={<Trans>No comments yet. Select text in the document to add one.</Trans>}
      testIdPrefix="comment-doc"
      scopeSwitch={scopeSwitch}
    />
  );
}

export function CommentsPanel({
  docName,
  scopeSwitch,
}: {
  docName: string;
  scopeSwitch?: ReactNode;
}) {
  return (
    <ProfilerBoundary name="comments-panel">
      <CommentsPanelInner docName={docName} scopeSwitch={scopeSwitch} />
    </ProfilerBoundary>
  );
}
