import { useSyncExternalStore } from 'react';
import { getBranchSnapshot, subscribeToBranch } from '@/lib/current-branch-store';

/**
 * Current git branch reported by the server. Backed by a shared module-level
 * store so every consumer reads from one cache and one bootstrap fetch. Returns
 * `null` when the project isn't a git checkout, HEAD is detached, or the
 * bootstrap fetch hasn't resolved yet.
 */
export function useCurrentBranch(): string | null {
  return useSyncExternalStore(subscribeToBranch, getBranchSnapshot, getBranchSnapshot);
}
