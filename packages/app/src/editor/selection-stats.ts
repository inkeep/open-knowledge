/**
 * Module-level store for selection-scoped document stats (words / chars /
 * tokens), keyed by (docName, surface). Mirrors `active-editor.ts`: each
 * mounted editor publishes its current selection's stats here, and the footer
 * reads the entry for the active doc + active surface via
 * `use-selection-stats.ts` (`useSyncExternalStore`).
 *
 * Keyed by **both** docName and surface because a doc opened in source mode at
 * least once keeps BOTH its WYSIWYG and source editors mounted (the inactive
 * one goes `Activity` hidden, not unmounted), and an editor's selection
 * listener is a TipTap/CodeMirror listener — not a React effect — so it keeps
 * firing while hidden. A bridge-driven `docChanged` (remote peer / agent write)
 * would otherwise make the hidden editor publish its own (collapsed) selection
 * and clobber the visible editor's entry for the same doc. Separate surface
 * keys keep the hidden editor's writes off the key the footer reads. A `null`
 * publish clears that surface's entry (no / collapsed selection → footer falls
 * back to the whole-document counts).
 */

import type { EditorView } from '@codemirror/view';
import type { Editor } from '@tiptap/core';
import { computeSelectionStats, type DocumentStats } from '@/lib/document-stats';

/**
 * Trailing debounce for selection-stats publishes. Selection events fire
 * rapidly during drag-select; counting is cheap but re-rendering the footer on
 * every tick is wasteful. Applied at each editor's publish site, not in the
 * reading hook.
 */
export const SELECTION_STATS_DEBOUNCE_MS = 120;

/** The edit surfaces that can hold a selection for a given doc. `wysiwyg` and
 *  `source` are the two body editors; `frontmatter` is the property panel, which
 *  publishes a selection-context snapshot (not stats) when the user highlights
 *  property text so the composer treats it like a body selection. */
export type EditorSurface = 'wysiwyg' | 'source' | 'frontmatter';

const statsByDocSurface = new Map<string, DocumentStats>();
const listeners = new Set<() => void>();

// Surface is the prefix (fixed 2-value vocabulary, no ':'), so the first ':'
// always terminates it — the key stays injective for any docName content.
const keyFor = (docName: string, surface: EditorSurface): string => `${surface}:${docName}`;

function notify(): void {
  for (const listener of listeners) listener();
}

export function publishSelectionStats(
  docName: string,
  surface: EditorSurface,
  stats: DocumentStats | null,
): void {
  const key = keyFor(docName, surface);
  if (stats === null) {
    // Only notify when an entry actually existed — avoids waking subscribers
    // on every collapsed-selection tick for a surface with no live selection.
    if (statsByDocSurface.delete(key)) notify();
    return;
  }
  // The extraction helpers mint a fresh object every call, so skip the
  // set + notify when the values are unchanged. This keeps the stored snapshot
  // a stable reference across value-identical publishes (the contract
  // `use-selection-stats.ts` relies on) and avoids redundant footer re-renders.
  const prev = statsByDocSurface.get(key);
  if (
    prev &&
    prev.words === stats.words &&
    prev.chars === stats.chars &&
    prev.tokens === stats.tokens
  ) {
    return;
  }
  statsByDocSurface.set(key, stats);
  notify();
}

export function getSelectionStats(
  docName: string | null,
  surface: EditorSurface,
): DocumentStats | null {
  if (docName === null) return null;
  return statsByDocSurface.get(keyFor(docName, surface)) ?? null;
}

export function subscribeSelectionStats(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Stats for the WYSIWYG editor's current selection, or `null` when collapsed /
 * whitespace-only. ProseMirror text is already visible (no markdown syntax), so
 * it is counted directly without re-parsing.
 */
export function selectionStatsFromWysiwyg(editor: Editor): DocumentStats | null {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const text = editor.state.doc.textBetween(from, to, '\n', ' ');
  if (!text.trim()) return null;
  return computeSelectionStats(text, { isMarkdown: false });
}

/**
 * Stats for the source-mode (CodeMirror) selection across all non-empty ranges
 * (multi-cursor selections sum), or `null` when nothing is selected. The text
 * is raw markdown, so it is run through the same visible-text extraction the
 * document counter uses.
 */
export function selectionStatsFromSource(view: EditorView): DocumentStats | null {
  const parts: string[] = [];
  for (const range of view.state.selection.ranges) {
    if (!range.empty) parts.push(view.state.sliceDoc(range.from, range.to));
  }
  if (parts.length === 0) return null;
  const text = parts.join('\n');
  if (!text.trim()) return null;
  return computeSelectionStats(text, { isMarkdown: true });
}
