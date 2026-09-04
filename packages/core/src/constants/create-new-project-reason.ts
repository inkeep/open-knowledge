export type CreateNewProjectFailureReason =
  | 'invalid-args'
  | 'nested-project'
  | 'target-not-empty'
  | 'mkdir-failed'
  | 'git-init-failed'
  | 'init-failed'
  | 'discovery-failed';

export const CREATE_NEW_PROJECT_FAILURE_REASONS = [
  'invalid-args',
  'nested-project',
  'target-not-empty',
  'mkdir-failed',
  'git-init-failed',
  'init-failed',
  'discovery-failed',
] as const satisfies readonly CreateNewProjectFailureReason[];
