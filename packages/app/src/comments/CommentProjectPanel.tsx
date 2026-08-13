/**
 * The "This project" comment scope: every comment in the workspace, bucketed
 * under the file it sits on.
 *
 * The twin of the This-doc scope, and deliberately the same component under it —
 * this side used to be a queue view that listed ONLY what was already marked to
 * send, which made the two halves of one tab answer different questions. Now
 * both list comments and the tick says which of them go out, so switching scope
 * widens the set without changing what you are looking at.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { CommentListPanel } from './CommentListPanel';
import { useAllThreads } from './store';

export function CommentProjectPanel({ scopeSwitch }: { scopeSwitch?: ReactNode }) {
  const threads = useAllThreads();
  return (
    <CommentListPanel
      threads={threads}
      groupByDocument
      empty={<Trans>No comments in this project yet. Comment on a passage to start one.</Trans>}
      testIdPrefix="comment-queue"
      scopeSwitch={scopeSwitch}
    />
  );
}
