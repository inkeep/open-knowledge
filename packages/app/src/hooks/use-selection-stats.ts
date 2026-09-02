import { useSyncExternalStore } from 'react';
import {
  type EditorSurface,
  getSelectionStats,
  subscribeSelectionStats,
} from '@/editor/selection-stats';
import type { DocumentStats } from '@/lib/document-stats';

export function useSelectionStats(
  activeDocName: string | null,
  surface: EditorSurface,
): DocumentStats | null {
  return useSyncExternalStore(subscribeSelectionStats, () =>
    getSelectionStats(activeDocName, surface),
  );
}
