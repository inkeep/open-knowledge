/**
 * Bucketing for the queue panel: queued comments grouped under their document.
 *
 * A file appears ONCE, at the position of its first queued comment, and later
 * comments on it join that bucket rather than opening a second one — commenting
 * across two files alternately would otherwise produce a heading per comment,
 * which is the repetition the grouping exists to remove.
 */

import type { CommentThread } from './types';

export interface QueueGroup {
  docName: string;
  threads: CommentThread[];
}

export function groupByDoc(threads: readonly CommentThread[]): QueueGroup[] {
  const byDoc = new Map<string, CommentThread[]>();
  for (const thread of threads) {
    const bucket = byDoc.get(thread.docName);
    if (bucket) bucket.push(thread);
    else byDoc.set(thread.docName, [thread]);
  }
  return [...byDoc].map(([docName, group]) => ({ docName, threads: group }));
}
