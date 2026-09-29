import type { GitHubReferencePreview } from '@inkeep/open-knowledge-core';

export type ReferenceStatusTone = 'success' | 'attention' | 'severe' | 'danger';

export type ReferenceStatusLine =
  | { readonly kind: 'queued'; readonly tone: 'attention'; readonly position: number | null }
  | {
      readonly kind:
        | 'queue-unmergeable'
        | 'conflicts'
        | 'changes-requested'
        | 'checks-failing'
        | 'auto-merge'
        | 'review-required'
        | 'checks-running'
        | 'blocked'
        | 'unstable'
        | 'behind'
        | 'approved'
        | 'ready';
      readonly tone: ReferenceStatusTone;
    };

export function referenceStatusLine(preview: GitHubReferencePreview): ReferenceStatusLine | null {
  const status = preview.status;
  if (status === undefined || preview.lifecycle !== 'open') return null;
  const { mergeQueue, autoMerge, mergeState, reviewDecision, checks } = status;
  const checksFailing = checks === 'FAILURE' || checks === 'ERROR';
  const checksRunning = checks === 'PENDING' || checks === 'EXPECTED';
  if (mergeQueue !== null) {
    if (mergeQueue.state === 'UNMERGEABLE') return { kind: 'queue-unmergeable', tone: 'danger' };
    return {
      kind: 'queued',
      tone: 'attention',
      position: mergeQueue.position >= 1 ? mergeQueue.position : null,
    };
  }
  if (mergeState === 'DIRTY') return { kind: 'conflicts', tone: 'danger' };
  if (reviewDecision === 'CHANGES_REQUESTED') return { kind: 'changes-requested', tone: 'danger' };
  if (mergeState === 'BLOCKED' && checksFailing) return { kind: 'checks-failing', tone: 'danger' };
  if (autoMerge) return { kind: 'auto-merge', tone: 'success' };
  if (mergeState === 'BLOCKED') {
    if (reviewDecision === 'REVIEW_REQUIRED') return { kind: 'review-required', tone: 'attention' };
    if (checksRunning) return { kind: 'checks-running', tone: 'attention' };
    return { kind: 'blocked', tone: 'attention' };
  }
  if (mergeState === 'UNSTABLE') {
    if (checksFailing) return { kind: 'unstable', tone: 'severe' };
    return checksRunning ? { kind: 'checks-running', tone: 'attention' } : null;
  }
  if (mergeState === 'BEHIND') return { kind: 'behind', tone: 'attention' };
  if (checksRunning) return { kind: 'checks-running', tone: 'attention' };
  if (mergeState === 'CLEAN' || mergeState === 'HAS_HOOKS') {
    return reviewDecision === 'APPROVED'
      ? { kind: 'approved', tone: 'success' }
      : { kind: 'ready', tone: 'success' };
  }
  return null;
}

export function diffBlocks(
  additions: number,
  deletions: number,
): readonly ('add' | 'del' | 'none')[] {
  const total = additions + deletions;
  const added = total === 0 ? 0 : Math.floor((5 * additions) / total);
  const removed = total === 0 ? 0 : Math.floor((5 * deletions) / total);
  return [
    ...Array<'add'>(added).fill('add'),
    ...Array<'del'>(removed).fill('del'),
    ...Array<'none'>(5 - added - removed).fill('none'),
  ];
}
