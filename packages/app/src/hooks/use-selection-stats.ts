import { useSyncExternalStore } from 'react';
import {
  type EditorSurface,
  getSelectionStats,
  subscribeSelectionStats,
} from '@/editor/selection-stats';
import type { DocumentStats } from '@/lib/document-stats';

/**
 * Selection-scoped stats for the active doc's currently-visible surface, or
 * `null` when there is no live selection (the footer then shows whole-document
 * counts). Both editors for a doc can stay mounted (one `Activity` hidden), so
 * reading by `surface` (the visible edit mode) ignores the hidden editor's
 * entry instead of racing it.
 *
 * The snapshot is a stable reference held by the store (or `null`), so it does
 * not churn `useSyncExternalStore` between publishes.
 */
export function useSelectionStats(
  activeDocName: string | null,
  surface: EditorSurface,
): DocumentStats | null {
  return useSyncExternalStore(subscribeSelectionStats, () =>
    getSelectionStats(activeDocName, surface),
  );
}
