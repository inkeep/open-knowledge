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
      scan = lineStart - 2; // -1 to step over the `\n`, -1 to land on prev line's last char
      continue;
    }
    return LIST_ITEM_LINE_RE.test(line);
  }
  return false;
}

export function dedentBlockJsxClose(source: string): string {
  if (!source.includes('</')) return source;

  const fences = findFencedRegions(source);

  let mutated = false;
  const result = source.replace(INDENTED_BLOCK_JSX_CLOSE_RE, (match, _lead, tag, trail, offset) => {
    if (isInsideFence(offset, fences)) return match;
    if (!isPrecededByListItem(source, offset)) return match;
    mutated = true;
    return `${tag}${trail}`;
  });
  return mutated ? result : source;
}
