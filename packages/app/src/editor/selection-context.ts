/**
 * Module-level store for the active doc's selection *context* — the richer
 * snapshot the bottom composer captures into a removable pill (the selected
 * markdown, its size, and source-mode line numbers). Sibling of
 * `selection-stats.ts` (same per-(docName, surface) keying + change-detected
 * publish/subscribe): that store carries only counts for the footer; this one
 * carries the passage + line range the composer turns into an inline / lines /
 * anchor reference. Both are published from the same debounced selection
 * listener in each editor, so this store applies no debounce of its own.
 */

import type { EditorView } from '@codemirror/view';
import type { ComposeSelection } from '@inkeep/open-knowledge-core';
import type { Editor } from '@tiptap/core';
import { serializeWysiwygSelection } from './edit-with-ai-selection';
import type { EditorSurface } from './selection-stats';

/**
 * A captured selection: the passage plus everything the composer needs to decide
 * inline vs reference. `sourceLineStart`/`sourceLineEnd` are set in source mode
 * only (rich text has no real line numbers).
 */
export interface SelectionSnapshot {
  readonly surface: EditorSurface;
  readonly docName: string;
  readonly markdown: string;
  readonly charLen: number;
  readonly lineCount: number;
  readonly sourceLineStart?: number;
  readonly sourceLineEnd?: number;
}

/** Inline-vs-reference threshold: only a short single-line pick is inlined
 *  verbatim; anything larger is referenced. */
export const INLINE_SELECTION_MAX_CHARS = 100;

/**
 * Map a captured selection to its dispatch transport. A single line under
 * `INLINE_SELECTION_MAX_CHARS` is inlined verbatim; anything larger references
 * the passage — by source line numbers when available (source mode), else by a
 * passage anchor (rich text, which has no line numbers).
 */
export function selectionSnapshotToCompose(s: SelectionSnapshot): ComposeSelection {
  if (s.lineCount === 1 && s.charLen < INLINE_SELECTION_MAX_CHARS) {
    return { kind: 'inline', markdown: s.markdown };
  }
  if (s.surface === 'source' && s.sourceLineStart !== undefined && s.sourceLineEnd !== undefined) {
    return { kind: 'lines', startLine: s.sourceLineStart, endLine: s.sourceLineEnd };
  }
  return { kind: 'anchor', markdown: s.markdown };
}

/**
 * Compact, Cursor-style chip label for a captured selection — `name (range)`,
 * never the rendered content. A source-mode line selection shows its real line
 * range (`name (10-12)` / `name (7)`); a rich-text or frontmatter selection has
 * no line numbers, so it shows the line/char extent instead (`name (3 lines)` /
 * `name (selection)`). `name` is the doc's display title (or the surface name
 * for frontmatter). The light-rendered preview is the expand/peek view, NOT this
 * label — so a heading/list/table selection never leaks literal `##`/`-`/`**`
 * markdown here.
 */
export function selectionChipLabel(s: SelectionSnapshot, name: string): string {
  if (s.sourceLineStart !== undefined && s.sourceLineEnd !== undefined) {
    const range =
      s.sourceLineStart === s.sourceLineEnd
        ? `${s.sourceLineStart}`
        : `${s.sourceLineStart}-${s.sourceLineEnd}`;
    return `${name} (${range})`;
  }
  if (s.lineCount > 1) return `${name} (${s.lineCount} lines)`;
  return `${name} (selection)`;
}

/**
 * Light, inline preview of a markdown passage for the chip's expand/peek view —
 * NOT a full renderer. It strips the leaking markdown syntax the raw label used
 * to show: heading `#`s drop (the heading text reads as the bold lead via the
 * caller's styling), list `-`/`*`/`+` bullets become a `•` glyph, blockquote
 * `>` markers drop, and newlines collapse to spaces so the preview stays a
 * single inline run. A block the inline form can't faithfully represent — a
 * table, a code fence, or an MDX/HTML/JSX tag — is replaced by its bare block
 * name (`table` / `code` / `component`) rather than dumping its source.
 */
export function lightRenderMarkdownPreview(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      // Toggle fence state; emit a single `code` placeholder on the opening
      // fence and swallow the body + closing fence.
      if (!inFence) out.push('code');
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line === '') continue;
    // A table row (pipe-delimited) or its delimiter row collapses to `table`.
    if (/^\|.*\|?$/.test(line) && line.includes('|')) {
      if (out[out.length - 1] !== 'table') out.push('table');
      continue;
    }
    // An MDX / HTML / JSX block — a line that opens with a tag — collapses to
    // `component` rather than leaking angle-bracket source.
    if (/^<\/?[A-Za-z]/.test(line)) {
      if (out[out.length - 1] !== 'component') out.push('component');
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(heading[1] ?? '');
      continue;
    }
    const listItem = line.match(/^[-*+]\s+(.*)$/);
    if (listItem) {
      out.push(`• ${listItem[1] ?? ''}`);
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      out.push(`• ${ordered[1] ?? ''}`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      out.push(quote[1] ?? '');
      continue;
    }
    out.push(line);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

const byDocSurface = new Map<string, SelectionSnapshot>();
const listeners = new Set<() => void>();

const keyFor = (docName: string, surface: EditorSurface): string => `${surface}:${docName}`;

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Two snapshots are equivalent when their passage + source line range match
 * (the derived counts follow). Keeps the stored reference stable across
 * value-identical publishes so `useSyncExternalStore` does not churn.
 */
function sameSnapshot(a: SelectionSnapshot, b: SelectionSnapshot): boolean {
  return (
    a.markdown === b.markdown &&
    a.sourceLineStart === b.sourceLineStart &&
    a.sourceLineEnd === b.sourceLineEnd
  );
}

export function publishSelectionContext(
  docName: string,
  surface: EditorSurface,
  snapshot: SelectionSnapshot | null,
): void {
  const key = keyFor(docName, surface);
  if (snapshot === null) {
    if (byDocSurface.delete(key)) notify();
    return;
  }
  const prev = byDocSurface.get(key);
  if (prev && sameSnapshot(prev, snapshot)) return;
  byDocSurface.set(key, snapshot);
  notify();
}

export function getSelectionContext(
  docName: string | null,
  surface: EditorSurface,
): SelectionSnapshot | null {
  if (docName === null) return null;
  return byDocSurface.get(keyFor(docName, surface)) ?? null;
}

export function subscribeSelectionContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Capture the WYSIWYG selection (markdown + newline-derived line count), or
 * `null` when collapsed / whitespace-only. Rich text has no source line numbers.
 */
export function selectionSnapshotFromWysiwyg(
  editor: Editor,
  docName: string,
): SelectionSnapshot | null {
  if (editor.state.selection.empty) return null;
  const markdown = serializeWysiwygSelection(editor);
  if (!markdown.trim()) return null;
  return {
    surface: 'wysiwyg',
    docName,
    markdown,
    charLen: markdown.trim().length,
    lineCount: (markdown.match(/\n/g)?.length ?? 0) + 1,
  };
}

/**
 * Capture a frontmatter (property-panel) text selection as a snapshot, keyed
 * like the body surfaces so it flows into the composer identically. The panel is
 * plain React widgets — not an editor — so there are no source line numbers; the
 * passage is the highlighted property text, treated as rich-text (inline for a
 * short single-line pick, anchor otherwise). `null` when the highlight is
 * empty / whitespace-only.
 */
export function selectionSnapshotFromFrontmatter(
  text: string,
  docName: string,
): SelectionSnapshot | null {
  if (!text.trim()) return null;
  return {
    surface: 'frontmatter',
    docName,
    markdown: text,
    charLen: text.trim().length,
    lineCount: (text.match(/\n/g)?.length ?? 0) + 1,
  };
}

/**
 * Capture the source-mode (CodeMirror) selection: the sliced markdown plus the
 * real line range spanning all non-empty ranges, or `null` when nothing is
 * selected.
 */
export function selectionSnapshotFromSource(
  view: EditorView,
  docName: string,
): SelectionSnapshot | null {
  const parts: string[] = [];
  let minFrom = Number.POSITIVE_INFINITY;
  let maxTo = -1;
  for (const range of view.state.selection.ranges) {
    if (range.empty) continue;
    parts.push(view.state.sliceDoc(range.from, range.to));
    minFrom = Math.min(minFrom, range.from);
    maxTo = Math.max(maxTo, range.to);
  }
  if (parts.length === 0) return null;
  const markdown = parts.join('\n');
  if (!markdown.trim()) return null;
  const sourceLineStart = view.state.doc.lineAt(minFrom).number;
  const sourceLineEnd = view.state.doc.lineAt(maxTo).number;
  return {
    surface: 'source',
    docName,
    markdown,
    charLen: markdown.trim().length,
    lineCount: sourceLineEnd - sourceLineStart + 1,
    sourceLineStart,
    sourceLineEnd,
  };
}
