import { createMergeHistoryRecorder } from './merge-history.ts';

export const NO_SHADOW_MERGE_HISTORY = createMergeHistoryRecorder({
  getShadow: () => undefined,
  contentRoot: '',
  getBranch: () => null,
});
