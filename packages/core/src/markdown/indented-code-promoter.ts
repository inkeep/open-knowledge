import type { Code, Paragraph, Root } from 'mdast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';

const INDENT_RE = /^( {4}|\t)/;

function hasIndentEveryNonBlankLine(slice: string): boolean {
  const lines = slice.split('\n');
  let nonBlankSeen = false;
  for (const line of lines) {
    if (line.length === 0) continue;
    nonBlankSeen = true;
    if (!INDENT_RE.test(line)) return false;
  }
  return nonBlankSeen;
}

function deindent(slice: string): string {
  return slice
    .split('\n')
    .map((line) => {
      if (line.length === 0) return line;
      if (line.startsWith('    ')) return line.slice(4);
      if (line.startsWith('\t')) return line.slice(1);
      return line;
    })
    .join('\n');
}

function promoteParagraphToCode(paragraph: Paragraph, source: string): Code | null {
  const pos = paragraph.position;
  if (!pos || typeof pos.start.offset !== 'number' || typeof pos.end.offset !== 'number') {
    return null;
  }
  const start = pos.start.offset;
  const end = pos.end.offset;
  if (start < 0 || end > source.length || start >= end) return null;

  let lineStart = start;
  while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
  if (lineStart === start) return null;

  const firstLinePrefix = source.slice(lineStart, start);
  if (!INDENT_RE.test(firstLinePrefix)) return null;

  const slice = source.slice(lineStart, end);
  if (!hasIndentEveryNonBlankLine(slice)) return null;

  const codePosition = {
    start: {
      line: pos.start.line,
      column: 1,
      offset: lineStart,
    },
    end: pos.end,
  };

  const value = deindent(slice).replace(/\n+$/, '');

  return {
    type: 'code',
    lang: null,
    meta: null,
    value,
    position: codePosition,
    data: { sourceStyle: 'indented' },
  };
}

export const indentedCodePromoterPlugin: Plugin<[], Root> = function indentedCodePromoterPlugin() {
  return (tree: Root, file: VFile) => {
    const source = String(file.value ?? '');
    if (!source) return;

    visit(tree, 'paragraph', (node, index, parent) => {
      if (!parent || parent.type !== 'root' || index == null) return;
      const prev = parent.children[index - 1];
      if (prev && prev.type === 'list') return;
      const promoted = promoteParagraphToCode(node, source);
      if (!promoted) return;
      (parent.children as unknown as Code[])[index] = promoted;
    });
  };
};
