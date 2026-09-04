import { useSyncExternalStore } from 'react';
import { getBranchSnapshot, subscribeToBranch } from '@/lib/current-branch-store';

export function useCurrentBranch(): string | null {
  return useSyncExternalStore(subscribeToBranch, getBranchSnapshot, getBranchSnapshot);
}
