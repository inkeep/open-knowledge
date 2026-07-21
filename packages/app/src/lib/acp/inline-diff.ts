/**
 * Row model for the transcript's inline tool-call diff: a genuine line diff
 * (jsdiff) instead of "all old lines red, all new lines green". Long
 * unchanged runs collapse to a gap row so a one-line edit in a large file
 * reads as a one-line edit.
 */

import { diffLines } from 'diff';

export type DiffRow =
  | { type: 'add' | 'del' | 'ctx'; text: string }
  | { type: 'gap'; count: number };

/** Unchanged runs longer than this collapse to leading/trailing context + a gap. */
const CONTEXT_LINES = 3;
const COLLAPSE_THRESHOLD = CONTEXT_LINES * 2 + 2;

function toLines(value: string): string[] {
  const lines = value.split('\n');
  // A diff part's value ends with the trailing newline of its last line —
  // drop the phantom empty line it splits into (but keep a genuinely empty
  // final line when the part has no trailing newline at all).
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function computeDiffRows(oldText: string | null, newText: string): DiffRow[] {
  if (oldText === null) {
    return toLines(newText).map((text) => ({ type: 'add' as const, text }));
  }
  const rows: DiffRow[] = [];
  const parts = diffLines(oldText, newText);
  for (const [index, part] of parts.entries()) {
    const lines = toLines(part.value);
    if (part.added) {
      for (const text of lines) rows.push({ type: 'add', text });
      continue;
    }
    if (part.removed) {
      for (const text of lines) rows.push({ type: 'del', text });
      continue;
    }
    if (lines.length <= COLLAPSE_THRESHOLD) {
      for (const text of lines) rows.push({ type: 'ctx', text });
      continue;
    }
    // Head context only after a change; tail context only before one — the
    // file's untouched top/bottom collapse entirely.
    const head = index > 0 ? lines.slice(0, CONTEXT_LINES) : [];
    const tail = index < parts.length - 1 ? lines.slice(-CONTEXT_LINES) : [];
    for (const text of head) rows.push({ type: 'ctx', text });
    rows.push({ type: 'gap', count: lines.length - head.length - tail.length });
    for (const text of tail) rows.push({ type: 'ctx', text });
  }
  return rows;
}
