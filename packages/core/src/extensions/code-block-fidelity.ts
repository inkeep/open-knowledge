/**
 * CodeBlock extension override for source-text fidelity.
 *
 * Extends @tiptap/extension-code-block (preserving setCodeBlock/toggleCodeBlock
 * commands, input rules, Tab indentation, and exit-on-triple-enter behavior)
 * and adds fidelity attributes for fence delimiter character (` vs ~) and
 * fence length.
 *
 * Markdown parsing/serialization is handled by the unified pipeline (packages/core/src/markdown/).
 */

import CodeBlock from '@tiptap/extension-code-block';

export const CodeBlockFidelity = CodeBlock.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      fenceDelimiter: { default: '`' },
      fenceLength: { default: 3 },
      // Info-string suffix after the language token (CommonMark §4.5):
      // ```js title="foo" → meta = 'title="foo"'. The mdast→PM forward
      // handler at markdown/index.ts already passes this through; without
      // a schema attr to receive it the value silently drops.
      meta: { default: null },
      // CommonMark §4.4 indented vs §4.5 fenced. Default 'fenced' matches
      // the existing fenceDelimiter/fenceLength defaults — TipTap input
      // rules and toolbar buttons produce fenced code by convention; only
      // parse-time recovery from indented source flips this to 'indented'.
      sourceStyle: { default: 'fenced' },
      // Closing-fence run length when longer than the opener (CommonMark
      // §4.5), fenced-block leading indent (1-3 spaces), and the space run
      // between the fence and the info string. Captured at parse time;
      // null = canonical form (mirror opener / flush-left / no gap).
      sourceClosingFenceLength: { default: null, rendered: false },
      sourceFenceIndent: { default: null, rendered: false },
      sourceInfoPadding: { default: null, rendered: false },
      // Per-line leading indent bytes of an indented (§4.4) block, captured
      // at parse time so tab / mixed-whitespace indents round-trip. Null =
      // canonical 4-space form.
      sourceIndents: { default: null, rendered: false },
    };
  },
});
