import { findFirstDivergenceIndex } from './tolerance-telemetry.ts';

export const BRIDGE_LINE_KINDS = [
  'blank',
  'frontmatter-fence',
  'heading',
  'thematic-break',
  'fence',
  'blockquote',
  'bullet-list-item',
  'ordered-list-item',
  'table-row',
  'jsx-tag',
  'html-block',
  'paragraph',
  'absent',
] as const;

export type BridgeLineKind = (typeof BRIDGE_LINE_KINDS)[number];

export interface BridgeDivergenceLocation {
  index: number;
  normalizedLine: number;
  normalizedColumn: number;
  ytextLineKind: BridgeLineKind;
  fragmentLineKind: BridgeLineKind;
  precedingLineKind: BridgeLineKind;
}

function divergenceOffset(a: string, b: string): number {
  const found = findFirstDivergenceIndex(a, b);
  return found === -1 ? Math.min(a.length, b.length) : found;
}

export function classifyBridgeLine(line: string, isFirstLine = false): BridgeLineKind {
  if (line.trim() === '') return 'blank';
  const t = line.trimStart();
  if (isFirstLine && /^-{3,}\s*$/.test(t)) return 'frontmatter-fence';
  if (/^#{1,6}(\s|$)/.test(t)) return 'heading';
  if (/^(?:`{3,}|~{3,})/.test(t)) return 'fence';
  if (t.startsWith('>')) return 'blockquote';
  if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(t)) return 'thematic-break';
  if (/^[-+*](\s|$)/.test(t)) return 'bullet-list-item';
  if (/^\d+[.)](\s|$)/.test(t)) return 'ordered-list-item';
  if (t.startsWith('|')) return 'table-row';
  if (/^<\/?[A-Z]/.test(t)) return 'jsx-tag';
  if (/^<[a-z!/]/i.test(t)) return 'html-block';
  return 'paragraph';
}

export function locateBridgeDivergence(
  ytextNorm: string,
  fragmentNorm: string,
): BridgeDivergenceLocation {
  const index = divergenceOffset(ytextNorm, fragmentNorm);

  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < index; i++) {
    if (ytextNorm[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }

  return {
    index,
    normalizedLine: line,
    normalizedColumn: index - lastNewline,
    ytextLineKind: lineKindAt(ytextNorm, index, line),
    fragmentLineKind: lineKindAt(fragmentNorm, index, line),
    precedingLineKind: precedingKindAt(ytextNorm, index, line),
  };
}

function lineAt(s: string, index: number): string | null {
  if (index > s.length) return null;
  if (index === s.length && s.length > 0 && index > 0) return null;
  const start = s.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const end = s.indexOf('\n', index);
  return s.slice(start, end === -1 ? s.length : end);
}

function lineKindAt(s: string, index: number, lineOrdinal: number): BridgeLineKind {
  const line = lineAt(s, index);
  if (line === null) return 'absent';
  return classifyBridgeLine(line, lineOrdinal === 1);
}

function precedingKindAt(s: string, index: number, lineOrdinal: number): BridgeLineKind {
  if (lineOrdinal <= 1 || index > s.length) return 'absent';
  let cursor = s.lastIndexOf('\n', Math.max(0, index - 1));
  let ordinal = lineOrdinal;
  while (cursor > 0) {
    const start = s.lastIndexOf('\n', cursor - 1) + 1;
    const candidate = s.slice(start, cursor);
    ordinal--;
    if (candidate.trim() !== '') return classifyBridgeLine(candidate, ordinal === 1);
    cursor = start - 1;
  }
  return 'absent';
}
