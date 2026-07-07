import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

const brokenRefMark = Decoration.mark({ class: 'cm-link-ref-broken' });

/** Regex matching a block-level link reference definition: `[label]: url` at line start. */
const LINK_DEF_RE = /^\s{0,3}\[([^\]]+)\]:\s/;

/** Regex matching an inline reference link: `[text][label]`. */
const INLINE_REF_RE = /\[([^\]]*)\]\[([^\]]*)\]/g;

/** Lezer node names whose contents are literal code — `[text][label]` inside
 *  these is source being quoted, not a live reference link. Covers CommonMark
 *  fenced code, indented code, and inline code. */
const CODE_NODE_NAMES = new Set(['FencedCode', 'CodeBlock', 'InlineCode']);

interface InlineRef {
  from: number;
  to: number;
  label: string;
}

interface PositionRange {
  from: number;
  to: number;
}

/** True iff `pos` lies strictly inside any code range. Uses binary search. */
function inCodeRange(pos: number, codeRanges: PositionRange[]): boolean {
  let lo = 0;
  let hi = codeRanges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = codeRanges[mid];
    if (pos < r.from) hi = mid - 1;
    else if (pos >= r.to) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Collect doc-wide code ranges from the Lezer tree. Sorted by `from`. */
function collectCodeRanges(state: EditorState): PositionRange[] {
  const ranges: PositionRange[] = [];
  const tree = syntaxTree(state);
  tree.iterate({
    enter(node) {
      if (CODE_NODE_NAMES.has(node.name)) {
        ranges.push({ from: node.from, to: node.to });
        return false;
      }
    },
  });
  ranges.sort((a, b) => a.from - b.from);
  return ranges;
}

/** Scan the document to find definitions and inline references, then mark broken ones. */
export function scanBrokenRefs(state: EditorState): DecorationSet {
  const definitions = new Set<string>();
  const references: InlineRef[] = [];
  const doc = state.doc;
  const codeRanges = collectCodeRanges(state);

  // Pass 1: collect all block-level definitions (skip lines inside code blocks —
  // a `[label]: url` inside a ```markdown``` fence is literal source, not a def).
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (inCodeRange(line.from, codeRanges)) continue;
    const match = LINK_DEF_RE.exec(line.text);
    if (match) {
      definitions.add(match[1].toLowerCase());
    }
  }

  // Pass 2: collect all inline reference links (skip matches inside code ranges —
  // `[text][label]` inside a fenced code block or inline code is source being
  // quoted, not a live reference).
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (inCodeRange(line.from, codeRanges)) continue;
    // Skip definition lines — they're not inline references
    if (LINK_DEF_RE.test(line.text)) continue;

    INLINE_REF_RE.lastIndex = 0;
    for (;;) {
      const m = INLINE_REF_RE.exec(line.text);
      if (!m) break;
      const from = line.from + m.index;
      if (inCodeRange(from, codeRanges)) continue;
      const label = m[2] || m[1]; // collapsed form [text][] uses text as label
      references.push({
        from,
        to: from + m[0].length,
        label: label.toLowerCase(),
      });
    }
  }

  // Build decorations for broken references
  const decorations: Range<Decoration>[] = [];
  for (const ref of references) {
    if (!definitions.has(ref.label)) {
      decorations.push(brokenRefMark.range(ref.from, ref.to));
    }
  }

  decorations.sort((a, b) => a.from - b.from);
  return Decoration.set(decorations);
}

export const brokenRefField: Extension = StateField.define<DecorationSet>({
  create(state) {
    return scanBrokenRefs(state);
  },
  update(decorations: DecorationSet, tr) {
    if (!tr.docChanged) return decorations;
    return scanBrokenRefs(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});
