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
