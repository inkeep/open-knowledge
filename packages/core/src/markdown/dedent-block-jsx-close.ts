import { findFencedRegions, isInsideFence } from './fence-regions.ts';

const INDENTED_BLOCK_JSX_CLOSE_RE = /^([ ]{1,3})(<\/[A-Z][A-Za-z0-9_]*\s*>)([ \t]*)$/gm;

const LIST_ITEM_LINE_RE = /^[ ]{0,3}([-*+]|\d{1,9}[.)])([ \t]|$)/;

function isPrecededByListItem(source: string, closeLineStart: number): boolean {
  if (closeLineStart === 0) return false;
  let scan = closeLineStart - 1;
  while (scan >= 0) {
    let lineStart = scan;
    while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
    const line = source.slice(lineStart, scan === closeLineStart - 1 ? scan : scan + 1);
    if (line.trim().length === 0) {
      scan = lineStart - 2;
      continue;
    }
    return LIST_ITEM_LINE_RE.test(line);
  }
  return false;
}

export interface DedentEdit {
  at: number;
  removed: number;
}

export function dedentBlockJsxClose(source: string, edits?: DedentEdit[]): string {
  if (!source.includes('</')) return source;

  const fences = findFencedRegions(source);

  let mutated = false;
  const result = source.replace(
    INDENTED_BLOCK_JSX_CLOSE_RE,
    (match, lead: string, tag: string, trail: string, offset: number) => {
      if (isInsideFence(offset, fences)) return match;
      if (!isPrecededByListItem(source, offset)) return match;
      mutated = true;
      edits?.push({ at: offset, removed: lead.length });
      return `${tag}${trail}`;
    },
  );
  return mutated ? result : source;
}

export function undedentOffset(edits: readonly DedentEdit[], dedentedOffset: number): number {
  let cumulative = 0;
  for (const edit of edits) {
    if (edit.at - cumulative > dedentedOffset) break;
    cumulative += edit.removed;
  }
  return dedentedOffset + cumulative;
}
