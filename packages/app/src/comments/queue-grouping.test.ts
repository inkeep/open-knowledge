/**
 * The queue groups its cards by file, so the file name is a heading rather than
 * a badge on every card.
 *
 * What matters is the bucketing rule: a file appears ONCE, at its first queued
 * comment, and comments added later join that bucket. Commenting back and forth
 * across two files is the case that would otherwise reproduce the per-card
 * repetition the grouping removes, so it's the case pinned here.
 */

import { describe, expect, it } from 'vitest';
import { groupByDoc } from './queue-grouping';
import type { CommentThread } from './types';

function thread(id: string, docName: string): CommentThread {
  return {
    id,
    docName,
    anchor: { quote: `quote ${id}`, prefix: '', suffix: '', start: 0, end: 5 },
    status: 'open',
    body: `body ${id}`,
    createdAt: 1000,
    queued: true,
  };
}

describe('grouping the queue by file', () => {
  it('gives each file one bucket, ordered by its first comment', () => {
    const groups = groupByDoc([
      thread('a1', 'recipes/stir-fry'),
      thread('b1', 'notes/inbox'),
      thread('a2', 'recipes/stir-fry'),
    ]);

    expect(groups.map((group) => group.docName)).toEqual(['recipes/stir-fry', 'notes/inbox']);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(groups[1]?.threads.map((t) => t.id)).toEqual(['b1']);
  });

  it('keeps queue order inside a file', () => {
    const groups = groupByDoc([
      thread('t1', 'notes/inbox'),
      thread('t2', 'notes/inbox'),
      thread('t3', 'notes/inbox'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('separates files that share a basename', () => {
    // The heading shows the basename, but the bucket key is the full path —
    // two `README`s in different folders are two files, not one group.
    const groups = groupByDoc([thread('x', 'a/README'), thread('y', 'b/README')]);

    expect(groups.map((group) => group.docName)).toEqual(['a/README', 'b/README']);
  });

  it('returns nothing for an empty queue', () => {
    expect(groupByDoc([])).toEqual([]);
  });
});
