/**
 * Shared constants and utilities for agent flash plugins (WYSIWYG + Source).
 */
import type * as Y from 'yjs';
import type { AgentFlashEntry } from '../types/awareness';

/** Duration of the flash CSS animation in milliseconds. */
export const FLASH_DURATION_MS = 2000;

/** Minimum interval between consecutive flashes in milliseconds. */
export const FLASH_DEBOUNCE_MS = 500;

/** Time-to-live for activity map entries in milliseconds (auto-evicted). */
export const ACTIVITY_TTL_MS = 30_000;

/**
 * Auto-evict activity entries older than ACTIVITY_TTL_MS.
 * Called on each observation to prevent unbounded growth.
 */
export function evictStaleEntries(activityMap: Y.Map<unknown>): void {
  const now = Date.now();
  for (const [key, value] of activityMap.entries()) {
    const entry = value as AgentFlashEntry;
    if (entry.timestamp && now - entry.timestamp > ACTIVITY_TTL_MS) {
      activityMap.delete(key);
    }
  }
}

/**
 * Check if the activity map has entries newer than the given timestamp.
 */
export function hasNewEntries(activityMap: Y.Map<unknown>, since: number): boolean {
  for (const [, value] of activityMap.entries()) {
    const entry = value as AgentFlashEntry;
    if (entry.timestamp && entry.timestamp > since) {
      return true;
    }
  }
  return false;
}

/**
 * The top-level block index range `[from, to)` that differs between two block
 * snapshots, in AFTER coordinates, or null when `after` gained no blocks.
 *
 * A block snapshot is the serialized form of each top-level node (the server
 * takes it from the XmlFragment's children, which map 1:1 to PM top-level
 * nodes). A prefix/suffix scan collapses a whole-body `replace` that only
 * appended a section down to just the appended blocks — so follow mode flashes
 * and scrolls to where the agent actually wrote, not the whole doc. Pure
 * deletion (no new/changed blocks in `after`) returns null: there is nothing
 * to flash.
 */
export function changedBlockRange(
  before: readonly string[],
  after: readonly string[],
): { from: number; to: number } | null {
  const n = before.length;
  const m = after.length;
  let start = 0;
  while (start < n && start < m && before[start] === after[start]) start++;
  let endBefore = n;
  let endAfter = m;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  if (endAfter <= start) return null;
  return { from: start, to: endAfter };
}
