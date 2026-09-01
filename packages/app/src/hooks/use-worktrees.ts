import { useSyncExternalStore } from 'react';
import { getWorktreesSnapshot, subscribeToWorktrees } from '@/lib/worktree-store';

export function useWorktrees() {
  return useSyncExternalStore(subscribeToWorktrees, getWorktreesSnapshot, getWorktreesSnapshot);
}
