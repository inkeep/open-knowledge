/**
 * timeline-diff-store — cross-component channel for the full-pane Timeline
 * diff. The Timeline panel (right DocPanel) sets the active version; EditorArea
 * (center pane) reads it and paints `TimelineDiffPane` as a full-pane overlay
 * over the editor. A module store (not DocumentContext) keeps this isolated
 * from the central context + its test surface, matching the app's other
 * `*-store` + `doc-panel-events` channels.
 *
 * The overlay is per-doc: EditorArea only paints it while `docName` matches the
 * open document, and clears it on doc navigation — so a stale version can never
 * paint over an unrelated doc.
 */
import { useSyncExternalStore } from 'react';

export interface TimelineDiffView {
  /** Extension-less doc the version belongs to (matched against the open doc). */
  docName: string;
  /** The version being viewed — also the rollback target. */
  sha: string;
  /** vs-parent baseline (list-adjacency); null for the first/oldest version. */
  parentSha: string | null;
  /**
   * Number of newer visible timeline versions stacked after this one — what a
   * Restore rolls back. 0 for the latest version (Restore is then a no-op, so
   * the confirm's "rolls back N edits" warning is suppressed).
   */
  laterEdits: number;
  /** Display metadata for the pane header (precomputed by the Timeline row). */
  authorName: string;
  relativeTime: string;
  absoluteTime: string;
}

let current: TimelineDiffView | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Open the full-pane diff for a version. Replaces any currently-open one. */
export function openTimelineDiff(view: TimelineDiffView): void {
  current = view;
  notify();
}

/** Close the full-pane diff (no-op when already closed). */
export function closeTimelineDiff(): void {
  if (current !== null) {
    current = null;
    notify();
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot(): TimelineDiffView | null {
  return current;
}

/** Subscribe to the active full-pane diff (null when none is open). */
export function useTimelineDiffView(): TimelineDiffView | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
