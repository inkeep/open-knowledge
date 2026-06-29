
import type { EditorView } from '@codemirror/view';
import type { Editor } from '@tiptap/core';
import { computeSelectionStats, type DocumentStats } from '@/lib/document-stats';

export const SELECTION_STATS_DEBOUNCE_MS = 120;

/** The edit surfaces that can hold a selection for a given doc. `wysiwyg` and
 *  `source` are the two body editors; `frontmatter` is the property panel, which
 *  publishes a selection-context snapshot (not stats) when the user highlights
 *  property text so the composer treats it like a body selection. */
export type EditorSurface = 'wysiwyg' | 'source' | 'frontmatter';

const statsByDocSurface = new Map<string, DocumentStats>();
const listeners = new Set<() => void>();

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
    if (statsByDocSurface.delete(key)) notify();
    return;
  }
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

export function selectionStatsFromWysiwyg(editor: Editor): DocumentStats | null {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const text = editor.state.doc.textBetween(from, to, '\n', ' ');
  if (!text.trim()) return null;
  return computeSelectionStats(text, { isMarkdown: false });
}

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
