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
