import type { EditorView } from '@codemirror/view';
import type { ComposeSelection } from '@inkeep/open-knowledge-core';
import type { Editor } from '@tiptap/core';
import { serializeWysiwygSelection } from './edit-with-ai-selection';
import type { EditorSurface } from './selection-stats';

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

export function selectionSnapshotToCompose(s: SelectionSnapshot): ComposeSelection {
  if (s.lineCount === 1 && s.charLen < INLINE_SELECTION_MAX_CHARS) {
    return { kind: 'inline', markdown: s.markdown };
  }
  if (s.surface === 'source' && s.sourceLineStart !== undefined && s.sourceLineEnd !== undefined) {
    return { kind: 'lines', startLine: s.sourceLineStart, endLine: s.sourceLineEnd };
  }
  return { kind: 'anchor', markdown: s.markdown };
}

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

export function lightRenderMarkdownPreview(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      if (!inFence) out.push('code');
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line === '') continue;
    if (/^\|.*\|?$/.test(line) && line.includes('|')) {
      if (out[out.length - 1] !== 'table') out.push('table');
      continue;
    }
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
