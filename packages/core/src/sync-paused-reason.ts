export const SYNC_PAUSED_REASONS = [
  'auth-error',
  'detached-head',
  'dirty-tree',
  'diverged-local-commits',
  'external-changes-pending',
  'git-index-locked',
  'git-operation-in-progress',
  'no-commits-yet',
  'no-push-permission',
  'non-content-merge-failure',
  'protected-branch',
] as const;

export type SyncPausedReason = (typeof SYNC_PAUSED_REASONS)[number];
