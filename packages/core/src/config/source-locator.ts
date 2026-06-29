
import { type Document, isCollection, isNode, type Node } from 'yaml';
import type { ConfigIssueSource } from './errors.ts';

export interface LocateOptions {
  file: string;
  source: string;
  doc: Document;
  path: (string | number)[];
}

function resolveNode(doc: Document, path: (string | number)[]): Node | null {
  if (path.length === 0) {
    return (doc.contents as Node | null) ?? null;
  }
  const direct = doc.getIn(path, true);
  if (isNode(direct)) {
    return direct;
  }
  for (let i = path.length - 1; i >= 0; i--) {
    const parent = doc.getIn(path.slice(0, i), true);
    if (isNode(parent)) {
      return parent;
    }
  }
  return (doc.contents as Node | null) ?? null;
}

function offsetToLineCol(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const cap = Math.min(offset, source.length);
  for (let i = 0; i < cap; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function renderSnippet(
  source: string,
  startOffset: number,
  endOffset: number,
  line: number,
  column: number,
): string {
  const lines = source.split('\n');
  const lineIdx = line - 1; // 0-based
  if (lineIdx < 0 || lineIdx >= lines.length) return '';
  const targetLine = lines[lineIdx] ?? '';

  const lineStartOffset = startOffset - (column - 1);
  const lineEndOffset = lineStartOffset + targetLine.length;
  const highlightEnd = Math.min(endOffset, lineEndOffset);
  const highlightLen = Math.max(1, highlightEnd - startOffset);

  const out: string[] = [];
  const lineNumWidth = String(lineIdx + 2).length;
  for (let i = Math.max(0, lineIdx - 1); i <= Math.min(lines.length - 1, lineIdx + 1); i++) {
    const isTarget = i === lineIdx;
    const marker = isTarget ? '>' : ' ';
    const num = String(i + 1).padStart(lineNumWidth, ' ');
    out.push(`${marker} ${num} | ${lines[i] ?? ''}`);
    if (isTarget) {
      const pad = ' '.repeat(2 + lineNumWidth + 3 + column - 1);
      out.push(`${pad}${'^'.repeat(highlightLen)}`);
    }
  }
  return out.join('\n');
}

export function locateIssue(options: LocateOptions): ConfigIssueSource | undefined {
  const node = resolveNode(options.doc, options.path);
  if (!node) return undefined;
  const range = node.range;
  if (!range) return undefined;
  const [startOffset, , endOffset = startOffset] = range;
  const { line, column } = offsetToLineCol(options.source, startOffset);
  const useSingleLine = isCollection(node);
  const snippet = useSingleLine
    ? renderSnippet(options.source, startOffset, startOffset + 1, line, column)
    : renderSnippet(options.source, startOffset, endOffset, line, column);
  return {
    file: options.file,
    line,
    column,
    snippet: snippet.length > 0 ? snippet : undefined,
  };
}
