import type { WorktreeSelectorModel } from '@inkeep/open-knowledge-core/git/worktree-selector-model';
import { basenameOf } from './project-switcher-recents';

export interface CheckoutIdentity {
  readonly repositoryName: string | null;
  readonly checkoutDetail: string | null;
}

export interface CheckoutIdentityInput {
  readonly projectName: string | null;
  readonly branch: string | null;
  readonly worktreeModel: WorktreeSelectorModel | null;
}

export function checkoutIdentity({
  projectName,
  branch,
  worktreeModel,
}: CheckoutIdentityInput): CheckoutIdentity {
  const repositoryName = worktreeModel !== null ? basenameOf(worktreeModel.mainRoot) : projectName;
  const currentCheckout = worktreeModel?.entries.find((entry) => entry.isCurrent) ?? null;
  const worktreeName =
    currentCheckout?.worktreePath !== null && currentCheckout?.worktreePath !== undefined
      ? basenameOf(currentCheckout.worktreePath)
      : null;
  const checkoutName = branch ?? worktreeName;
  const projectScopeName = projectName === repositoryName ? null : projectName;
  const parts = [projectScopeName, checkoutName].filter((part): part is string => part !== null);
  return { repositoryName, checkoutDetail: parts.length > 0 ? parts.join(' · ') : null };
}
