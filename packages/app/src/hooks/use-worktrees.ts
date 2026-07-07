import { useSyncExternalStore } from 'react';
import { getWorktreesSnapshot, subscribeToWorktrees } from '@/lib/worktree-store';

/**
 * Subscribe to the cached worktree model for the current window's project.
 * Returns `null` until the first fetch lands (and on non-desktop hosts), then
 * the cached model on every subsequent render — shared across the ProjectSwitcher
 * submenu, command palette, and switcher search so the git fetch runs once.
 */
export function useWorktrees() {
  return useSyncExternalStore(subscribeToWorktrees, getWorktreesSnapshot, getWorktreesSnapshot);
}
