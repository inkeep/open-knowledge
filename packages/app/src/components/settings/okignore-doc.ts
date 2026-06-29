
export interface PatternLine {
  kind: 'pattern';
  raw: string;
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
  const rawLines = text.split('\n');
  const lines: Line[] = rawLines.map(classifyLine);
  return { lines };
}

export function serializeOkignoreDoc(doc: ParsedDoc): string {
  return doc.lines.map((line) => line.raw).join('\n');
}

export function listPatterns(doc: ParsedDoc): PatternLine[] {
  return doc.lines.filter((line): line is PatternLine => line.kind === 'pattern');
}

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
