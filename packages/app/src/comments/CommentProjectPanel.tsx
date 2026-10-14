import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { CommentListPanel } from './CommentListPanel';
import { useAllThreads } from './store';

export function CommentProjectPanel({
  scopeSwitch,
  onDestinationComplete,
}: {
  scopeSwitch?: ReactNode;
  onDestinationComplete?: (target: HTMLElement) => void;
}) {
  const threads = useAllThreads();
  return (
    <CommentListPanel
      threads={threads}
      groupByDocument
      empty={<Trans>No comments in this project yet. Comment on a passage to start one.</Trans>}
      testIdPrefix="comment-queue"
      scopeSwitch={scopeSwitch}
      onDestinationComplete={onDestinationComplete}
    />
  );
}
