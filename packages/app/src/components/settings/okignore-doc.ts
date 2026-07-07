/**
 * Pure parser + serializer + structural ops for the okignore Y.Text body.
 *
 * The raw `.okignore` text is the source of truth. Each line is classified as
 * pattern | comment | blank. Comments and blank lines are non-rendering
 * metadata preserved verbatim through any mutation (add, edit, remove,
 * reorder).
 *
 * Critical invariant: `serializeOkignoreDoc(parseOkignoreDoc(text)) === text`
 * for every input.
 *
 * Reorder semantics: pattern entries (raw + text together) move between
 * pattern-only slots; comments and blank lines stay at their original line
 * positions. This is the simplest correct behavior — full comment-tracking
 * reorder is reserved for the raw-text mode.
 *
 * Edit-to-empty == remove: an edit that produces a whitespace-only string is
 * treated as a delete so the persistence-time validator never sees an
 * `OKIGNORE_INVALID` line from a list-editor path. Adversarial paths (Add
 * input, raw-text mode, multi-client merge) still surface rejections via
 * the binding's subscribeRejection event.
 */

export interface PatternLine {
  kind: 'pattern';
  /** Verbatim original line bytes (no trailing newline). */
  raw: string;
  /** Trimmed pattern text used as the row label and for L1 dispatch. */
  text: string;
}

interface MetaLine {
  kind: 'comment' | 'blank';
  raw: string;
}

type Line = PatternLine | MetaLine;

interface ParsedDoc {
  lines: Line[];
}

function classifyLine(raw: string): Line {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'blank', raw };
  if (trimmed.startsWith('#')) return { kind: 'comment', raw };
  return { kind: 'pattern', raw, text: trimmed };
}

export function parseOkignoreDoc(text: string): ParsedDoc {
  // String.split('\n') reverses cleanly: 'a\nb\n' -> ['a', 'b', ''] -> 'a\nb\n'.
  // Preserving the trailing empty entry from a trailing newline lets us serialize
  // back byte-identically without a separate trailingNewline flag.
  const rawLines = text.split('\n');
  const lines: Line[] = rawLines.map(classifyLine);
  return { lines };
}

export function serializeOkignoreDoc(doc: ParsedDoc): string {
  return doc.lines.map((line) => line.raw).join('\n');
}

/** All visible pattern lines, in document order. */
export function listPatterns(doc: ParsedDoc): PatternLine[] {
  return doc.lines.filter((line): line is PatternLine => line.kind === 'pattern');
}

/**
 * Append a new pattern line at the end of the doc. Preserves trailing-newline
 * behavior — if the doc ends with a blank-empty line (representing a trailing
 * `\n`), the new pattern is inserted before that blank so the body still ends
 * with `\n`. Empty/whitespace input is rejected with the original doc unchanged
 * so the L3 path can't see whitespace-only adds from the list editor.
 *
 * Dedup: if the trimmed pattern already exists as a pattern line (compared by
 * trimmed `.text`), return the original doc reference unchanged. Both call
 * sites — settings "ADD PATTERN" and the sidebar "Hide folder" / "Hide this
 * file" context-menu actions — append through this primitive, so the dedup applies
 * to both. Comments are not considered pattern duplicates.
 */
export function appendPattern(doc: ParsedDoc, newText: string): ParsedDoc {
  const trimmed = newText.trim();
  if (trimmed.length === 0) return doc;
  for (const line of doc.lines) {
    if (line.kind === 'pattern' && line.text === trimmed) return doc;
  }
  const newLine: PatternLine = { kind: 'pattern', raw: trimmed, text: trimmed };
  const lines = doc.lines.slice();
  const last = lines[lines.length - 1];
  if (last && last.kind === 'blank' && last.raw === '') {
    lines.splice(lines.length - 1, 0, newLine);
  } else {
    lines.push(newLine, { kind: 'blank', raw: '' });
  }
  return { lines };
}

/** Index of the first pattern line with this trimmed text, or -1 if none. */
export function findPatternIndex(doc: ParsedDoc, patternText: string): number {
  const trimmed = patternText.trim();
  if (trimmed.length === 0) return -1;
  let seen = 0;
  for (const line of doc.lines) {
    if (line.kind === 'pattern') {
      if (line.text === trimmed) return seen;
      seen++;
    }
  }
  return -1;
}

/**
 * Replace the n-th pattern (0-indexed across pattern lines only) with the
 * trimmed `newText`. Empty/whitespace `newText` removes the line instead —
 * keeps L3 from receiving an OKIGNORE_INVALID line from the list editor.
 */
export function editPatternAt(doc: ParsedDoc, patternIndex: number, newText: string): ParsedDoc {
  const trimmed = newText.trim();
  if (trimmed.length === 0) return removePatternAt(doc, patternIndex);
  const slot = findNthPatternSlot(doc, patternIndex);
  if (slot < 0) return doc;
  const lines = doc.lines.slice();
  lines[slot] = { kind: 'pattern', raw: trimmed, text: trimmed };
  return { lines };
}

export function removePatternAt(doc: ParsedDoc, patternIndex: number): ParsedDoc {
  const slot = findNthPatternSlot(doc, patternIndex);
  if (slot < 0) return doc;
  const lines = doc.lines.slice();
  lines.splice(slot, 1);
  return { lines };
}

/**
 * Move the pattern at `fromIndex` to `toIndex` within the pattern-only
 * sequence. Comments and blank lines hold their original line positions —
 * pattern entries (raw + text together) rotate through pattern slots.
 */
export function reorderPatterns(doc: ParsedDoc, fromIndex: number, toIndex: number): ParsedDoc {
  if (fromIndex === toIndex) return doc;
  const slots: number[] = [];
  const patterns: PatternLine[] = [];
  doc.lines.forEach((line, i) => {
    if (line.kind === 'pattern') {
      slots.push(i);
      patterns.push(line);
    }
  });
  if (fromIndex < 0 || fromIndex >= patterns.length || toIndex < 0 || toIndex >= patterns.length) {
    return doc;
  }
  const reordered = patterns.slice();
  const [moved] = reordered.splice(fromIndex, 1);
  if (!moved) return doc;
  reordered.splice(toIndex, 0, moved);
  const lines = doc.lines.slice();
  slots.forEach((slotIdx, i) => {
    const next = reordered[i];
    if (next) lines[slotIdx] = next;
  });
  return { lines };
}

function findNthPatternSlot(doc: ParsedDoc, patternIndex: number): number {
  if (patternIndex < 0) return -1;
  let seen = 0;
  for (let i = 0; i < doc.lines.length; i++) {
    if (doc.lines[i]?.kind === 'pattern') {
      if (seen === patternIndex) return i;
      seen++;
    }
  }
  return -1;
}
