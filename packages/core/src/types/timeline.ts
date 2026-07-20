import type { ParsedCheckpoint, ShadowContributor } from '../shadow-repo-layout.ts';

export type { ShadowContributor };

/** Entry type classification — derived from shadow repo commit message prefix. */
export type EntryType = 'checkpoint' | 'wip' | 'upstream' | 'park';

/** A single timeline entry representing a checkpoint or WIP auto-save from the shadow repo. */
export interface TimelineEntry {
  sha: string;
  timestamp: string; // ISO 8601
  author: string;
  authorEmail: string;
  type: EntryType;
  message: string;
  /** Agent contributors parsed from the WIP commit message body. Empty for pre-attribution commits. */
  contributors: ShadowContributor[];
  /**
   * Structured checkpoint metadata parsed from the `ok-checkpoint-v1:` body line.
   * Present only for `type === 'checkpoint'` rows produced by `saveInMemoryCheckpoint`
   * (silent rescue artifacts — bridge-merge-loss or external-change-rescue).
   * `null` for ordinary `saveVersion` checkpoints, WIP rows, upstream rows, and
   * any checkpoint whose body line is missing or malformed.
   */
  checkpoint: ParsedCheckpoint | null;
  /**
   * SHA of the previous VISIBLE timeline entry for this doc — list-adjacency in
   * the assembled, ok-actor-filtered, timestamp-sorted result (`filtered[idx+1]`),
   * NOT `git <sha>^`. The timeline is a multi-ref merge, so the git parent is
   * usually another writer's commit or a filtered checkpoint; list-adjacency is
   * the "previous version a reader saw." `null` for the doc's first version or an
   * entry whose parent fell outside the depth-bounded walk. Baseline for the
   * vs-parent ("changes in this version") diff. Populated only in the per-doc
   * history path; absent on folder-timeline entries.
   */
  parentSha?: string | null;
}
