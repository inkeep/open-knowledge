import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension, Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

/** Regex to capture list-item prefix: leading whitespace + marker + optional task marker. */
const LIST_PREFIX_RE = /^(\s*(?:[-*+]|\d+[.)]) (?:\[[ x]\] )?)/;

const delMark = Decoration.mark({ class: 'cm-del' });

// --list-hang feeds the .cm-line additive-calc that owns per-line indent
// (!important); without it the base padding overrides the standalone
// .cm-table-row rule while its negative text-indent still applies, pulling
// table lines ~2ch left of prose. Same mechanism as .cm-list-item below.
const tableHeaderLine = Decoration.line({
  class: 'cm-table-header',
  attributes: { style: '--list-hang: 2ch' },
});
const tableRowLine = Decoration.line({
  class: 'cm-table-row',
  attributes: { style: '--list-hang: 2ch' },
});

/** Count leading ASCII spaces in a string. Tabs count as 4 visual columns. */
function countLeadingIndent(text: string): number {
  let indent = 0;
  for (const ch of text) {
    if (ch === ' ') indent++;
    else if (ch === '\t') indent += 4;
    else break;
  }
  return indent;
}

/**
 * Resolve `[fmStartLine, fmEndLine]` (1-indexed, inclusive) when the document
 * begins with a YAML frontmatter fence (`---\n…\n---`). Returns `null` when
 * there is no FM region.
 *
 * Decorations inside the FM region are skipped — markdown-list and
 * markdown-table parsing fires on YAML lines like `  - characters` and
 * `| col |`, but those aren't markdown constructs. The list-item decoration's
 * negative `text-indent` (`.cm-list-item` in globals.css) clips the leading
 * YAML indent into negative-x and makes `  - foo` render flush-left.
 */

// Line-scoped shape of the fence contract, sourced from core so the FM
// region the user sees styled as YAML matches what the bridge recognizes by
// construction (no local regex copy to drift). Re-exported for
// SourceEditor's outline-navigation FM skip.
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
        // Skip every decoration class for nodes that fall inside the YAML
        // frontmatter region. The lezer-markdown parser still tokenizes
        // `  - foo` as a ListItem, but the visual indent + hanging-indent
        // semantics of `.cm-list-item` (and the list/table/code styling
        // siblings) don't apply to YAML — applying them clips leading
        // whitespace into negative-x and makes the line render flush-left.
        if (insideFrontmatter(node.from)) return;
        // Strikethrough — apply .cm-del to content between ~~ delimiters
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

        // List hanging-indent — apply .cm-list-item to the first line of each ListItem.
        // Do NOT `return false` here: nested lists have ListItem descendants, and
        // inline content (Strikethrough, etc.) lives inside the item's Paragraph —
        // both need their own handler fires.
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

        // Fenced code — wrap-preserve-indent on content lines.
        // The language token (CodeInfo) stays as plain source text; syntax
        // highlighting for the language comes from the codeLanguages
        // allowlist (packages/app/src/editor/markdown-code-languages.ts).
        if (node.name === 'FencedCode') {
          // Code body lines — apply .cm-fenced-code-line with --line-indent.
          // Skip the opening fence line and closing fence line.
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

        // Tables — hanging indent only. Wrapped row continuation aligns under
        // cell content (not under `|`). NO background, border, accent bar,
        // cell bands, or font-size/line-height change — explicit scope
        // boundary.
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
          // The `|---|---|` separator row — a TableDelimiter whose parent is
          // Table directly (not TableHeader/TableRow). Inline `|` characters
          // inside rows are also TableDelimiters but their parent is the row,
          // so the parent check filters them out.
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
