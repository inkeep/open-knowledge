import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension, Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

const LIST_PREFIX_RE = /^(\s*(?:[-*+]|\d+[.)]) (?:\[[ x]\] )?)/;

const delMark = Decoration.mark({ class: 'cm-del' });

const tableHeaderLine = Decoration.line({
  class: 'cm-table-header',
  attributes: { style: '--list-hang: 2ch' },
});
const tableRowLine = Decoration.line({
  class: 'cm-table-row',
  attributes: { style: '--list-hang: 2ch' },
});

function countLeadingIndent(text: string): number {
  let indent = 0;
  for (const ch of text) {
    if (ch === ' ') indent++;
    else if (ch === '\t') indent += 4;
    else break;
  }
  return indent;
}


import { FM_FENCE_LINE_RE } from '@inkeep/open-knowledge-core';

export { FM_FENCE_LINE_RE };

function frontmatterRange(state: EditorState): { from: number; to: number } | null {
  if (state.doc.lines < 2) return null;
  const firstLine = state.doc.line(1);
  if (!FM_FENCE_LINE_RE.test(firstLine.text)) return null;
  for (let i = 2; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    if (FM_FENCE_LINE_RE.test(line.text)) {
      return { from: firstLine.from, to: line.to };
    }
  }
  return null;
}

/** Pure state-based decoration builder. Exported for unit tests — the ViewPlugin
 * wrapper passes `view.visibleRanges` (viewport-scoped); tests can pass the
 * whole-doc range to exercise every construct. No `view` dependency → works
 * in Bun's headless test env without a DOM. */
export function buildDecorationsForRanges(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  const fmRange = frontmatterRange(state);
  const insideFrontmatter = (pos: number): boolean =>
    fmRange !== null && pos >= fmRange.from && pos <= fmRange.to;

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (insideFrontmatter(node.from)) return;
        if (node.name === 'Strikethrough') {
          let contentFrom = node.from;
          let contentTo = node.to;
          const cursor = node.node.cursor();
          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'StrikethroughMark') {
                if (cursor.from === node.from) {
                  contentFrom = cursor.to;
                } else {
                  contentTo = cursor.from;
                }
              }
            } while (cursor.nextSibling());
          }
          if (contentFrom < contentTo) {
            decorations.push(delMark.range(contentFrom, contentTo));
          }
          return false;
        }

        if (node.name === 'ListItem') {
          const line = state.doc.lineAt(node.from);
          const match = LIST_PREFIX_RE.exec(line.text);
          const hang = match ? match[1].length : 2;
          const lineDeco = Decoration.line({
            class: 'cm-list-item',
            attributes: { style: `--list-hang: ${hang}ch` },
          });
          decorations.push(lineDeco.range(line.from));
          return;
        }

        if (node.name === 'FencedCode') {
          const startLine = state.doc.lineAt(node.from);
          const endLine = state.doc.lineAt(node.to);
          for (let lineNum = startLine.number + 1; lineNum < endLine.number; lineNum++) {
            const line = state.doc.line(lineNum);
            const indent = countLeadingIndent(line.text);
            const lineDeco = Decoration.line({
              class: 'cm-fenced-code-line',
              attributes: { style: `--line-indent: ${indent}` },
            });
            decorations.push(lineDeco.range(line.from));
          }

          return false;
        }

        if (node.name === 'TableHeader') {
          const line = state.doc.lineAt(node.from);
          decorations.push(tableHeaderLine.range(line.from));
          return false;
        }
        if (node.name === 'TableRow') {
          const line = state.doc.lineAt(node.from);
          decorations.push(tableRowLine.range(line.from));
          return false;
        }
        if (node.name === 'TableDelimiter' && node.node.parent?.name === 'Table') {
          const line = state.doc.lineAt(node.from);
          decorations.push(tableRowLine.range(line.from));
          return false;
        }
      },
    });
  }

  decorations.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(decorations);
}

class SourcePolishViewPlugin {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorationsForRanges(view.state, view.visibleRanges);
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.viewportChanged ||
      syntaxTree(update.startState) !== syntaxTree(update.state)
    ) {
      this.decorations = buildDecorationsForRanges(update.view.state, update.view.visibleRanges);
    }
  }
}

export const sourcePolishViewPlugin: Extension = ViewPlugin.fromClass(SourcePolishViewPlugin, {
  decorations: (v) => v.decorations,
});
