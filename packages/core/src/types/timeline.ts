import type { ParsedCheckpoint, ShadowContributor } from '../shadow-repo-layout.ts';

export type { ShadowContributor };

export type EntryType = 'checkpoint' | 'wip' | 'upstream' | 'park';

export interface TimelineEntry {
  sha: string;
  timestamp: string;
  author: string;
  authorEmail: string;
  type: EntryType;
  message: string;
  contributors: ShadowContributor[];
  checkpoint: ParsedCheckpoint | null;
  parentSha?: string | null;
}
