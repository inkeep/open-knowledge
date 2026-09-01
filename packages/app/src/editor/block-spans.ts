import {
  type MarkdownManager,
  MIN_CARRIED_EDGE_EMPTIES,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import type { Node as PmNode } from '@tiptap/pm/model';

export interface SourceBlockSpans {
  spans: { start: number; end: number }[];
  fmLineCount: number;
}

export interface SourceBlock {
  start: number;
  end: number;
  kind: string;
  text: string;
}

export function canonicalBlockKind(typeName: string): string {
  switch (typeName) {
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
    case 'list':
      return 'list';
    case 'codeBlock':
    case 'code':
      return 'code';
    case 'horizontalRule':
    case 'thematicBreak':
      return 'thematicBreak';
    case 'jsxComponent':
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement':
      return 'jsx';
    case 'htmlBlock':
    case 'html':
      return 'html';
    default:
      return typeName;
  }
}

function mdastText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map(mdastText).join('');
  }
  return '';
}

export function computeSourceBlocks(
  source: string,
  md: MarkdownManager,
): { blocks: SourceBlock[]; fmLineCount: number } {
  const { frontmatter, body } = stripFrontmatter(source);
  const fmLineCount = frontmatter === '' ? 0 : frontmatter.split('\n').length - 1;
  try {
    const blocks = md.parseToEditorMdast(body).children.map((child) => ({
      start: (child.position?.start.line ?? Number.POSITIVE_INFINITY) + fmLineCount,
      end: (child.position?.end.line ?? Number.NEGATIVE_INFINITY) + fmLineCount,
      kind: canonicalBlockKind(child.type),
      text: mdastText(child),
    }));
    return { blocks, fmLineCount };
  } catch {
    performance.mark('ok/block-spans/parse-failed');
    return { blocks: [], fmLineCount };
  }
}

export function computeSourceBlockSpans(source: string, md: MarkdownManager): SourceBlockSpans {
  const { blocks, fmLineCount } = computeSourceBlocks(source, md);
  return { spans: blocks.map((b) => ({ start: b.start, end: b.end })), fmLineCount };
}

export function blockIndexForLine(spans: SourceBlockSpans['spans'], line: number): number | null {
  if (spans.length === 0) return null;
  let lo = 0;
  let hi = spans.length - 1;
  let candidate = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (span !== undefined && span.end >= line) {
      candidate = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return candidate;
}

export function comparableChildCount(doc: PmNode): number {
  let trailingEmpty = 0;
  for (let i = doc.childCount - 1; i >= 0; i--) {
    const child = doc.child(i);
    if (child.type.name !== 'paragraph' || child.content.size !== 0) break;
    trailingEmpty++;
  }
  return trailingEmpty < MIN_CARRIED_EDGE_EMPTIES ? doc.childCount - trailingEmpty : doc.childCount;
}

export function blockRangeToPositions(
  doc: PmNode,
  fromBlock: number,
  toBlock: number,
): { from: number; to: number } | null {
  const childCount = doc.childCount;
  const first = Math.max(0, Math.min(fromBlock, childCount));
  const last = Math.max(first, Math.min(toBlock, childCount));
  if (last <= first) return null;
  let pos = 0;
  for (let i = 0; i < first; i++) pos += doc.child(i).nodeSize;
  const from = pos;
  for (let i = first; i < last; i++) pos += doc.child(i).nodeSize;
  const to = pos;
  const size = doc.content.size;
  const clampedFrom = Math.max(0, Math.min(from, size));
  const clampedTo = Math.max(clampedFrom, Math.min(to, size));
  if (clampedTo <= clampedFrom) return null;
  return { from: clampedFrom, to: clampedTo };
}

export function lineStartOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

export function lineToOffset(offsets: number[], line: number, sourceLength: number): number {
  if (line <= 1) return 0;
  if (line - 1 >= offsets.length) return sourceLength;
  return offsets[line - 1] ?? sourceLength;
}

export function offsetToLine(offsets: number[], offset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  let line = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid] ?? 0) <= offset) {
      line = mid + 1;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return line;
}
