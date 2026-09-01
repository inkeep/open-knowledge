import type { Text } from '@codemirror/state';
import {
  createCodeFenceTracker,
  FM_FENCE_LINE_RE,
  scanHeadingLine,
} from '@inkeep/open-knowledge-core';

export interface SourceHeadingLine {
  slug: string;
  from: number;
}

let cachedDoc: Text | null = null;
let cachedEntries: SourceHeadingLine[] = [];

export function sourceHeadingLines(doc: Text): readonly SourceHeadingLine[] {
  if (doc === cachedDoc) return cachedEntries;
  const entries = scanDoc(doc);
  cachedDoc = doc;
  cachedEntries = entries;
  return entries;
}

function scanDoc(doc: Text): SourceHeadingLine[] {
  const entries: SourceHeadingLine[] = [];
  const slugCounts = new Map<string, number>();
  const isInCodeFence = createCodeFenceTracker();

  for (let i = frontmatterBodyStart(doc); i <= doc.lines; i++) {
    const line = doc.line(i);
    if (isInCodeFence(line.text)) continue;
    const heading = scanHeadingLine(line.text, slugCounts);
    if (heading) entries.push({ slug: heading.slug, from: line.from });
  }

  return entries;
}

function frontmatterBodyStart(doc: Text): number {
  if (!isFenceLine(doc.line(1).text)) return 1;
  for (let i = 2; i <= doc.lines; i++) {
    if (isFenceLine(doc.line(i).text)) return i + 1;
  }
  return 1;
}

function isFenceLine(line: string): boolean {
  return FM_FENCE_LINE_RE.test(line.endsWith('\r') ? line.slice(0, -1) : line);
}
