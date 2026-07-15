import type { LintPosition, LintTextEdit } from './types.ts';

export function applyTextEdits(text: string, edits: readonly LintTextEdit[]): string {
  if (edits.length === 0) return text;
  const lineStarts = computeLineStarts(text);
  const resolved = edits.map((edit) => ({
    start: offsetAt(text, lineStarts, edit.range.start),
    end: offsetAt(text, lineStarts, edit.range.end),
    newText: edit.newText,
  }));
  resolved.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const edit of resolved) {
    const start = Math.min(edit.start, edit.end);
    const end = Math.max(edit.start, edit.end);
    out = out.slice(0, start) + edit.newText + out.slice(end);
  }
  return out;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function offsetAt(text: string, lineStarts: number[], position: LintPosition): number {
  if (position.line < 0) return 0;
  if (position.line >= lineStarts.length) return text.length;
  const lineStart = lineStarts[position.line] as number;
  const lineEnd =
    position.line + 1 < lineStarts.length
      ? (lineStarts[position.line + 1] as number) - 1 // before the '\n'
      : text.length;
  return Math.min(lineStart + Math.max(0, position.character), lineEnd);
}
