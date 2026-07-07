import { Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mathInline: {
      insertMathInline: (formula: string) => ReturnType;
    };
  }
}

/**
 * mathInline — PM atom for live-rendered inline math.
 *
 * Shape: `atom: true, inline: true, group: 'inline', selectable: true`.
 * The formula lives on the `formula` attr (LaTeX source string); KaTeX
 * renders inline-flow via the app-side NodeView (`MathInlineView.tsx`,
 * registered via `addNodeView`).
 *
 * Authoring forms that resolve to this PM node:
 *   - `$$x$$` mid-paragraph or single-line standalone (remark-math
 *     classifies single-line `$$…$$` as inline math under
 *     `singleDollarTextMath: false`)
 *   - `$x$` mid-paragraph — recognized by the post-parse heuristic walker
 *     in `markdown/single-dollar-math-promoter.ts` (currency-safe;
 *     `singleDollarTextMath` stays `false` on remark-math itself because
 *     its loose pairing tripped a regression)
 *   - `<InlineMath formula="x" />` MDX JSX (mdxJsxTextElement → mathInline)
 *
 * Block math (`$$\n…\n$$`, ` ```math `, `<Math>`) lands on `jsxComponent`
 * via the `<Math>` canonical descriptor — see `Math` in
 * `registry/built-ins.ts`.
 *
 * ## Why a dedicated PM node, not jsxInline + descriptor dispatch
 *
 * `jsxInline` is intentionally render-less — renders as visible source
 * text in WYSIWYG, no live React render, no PropPanel. Extending
 * descriptor dispatch into the inline group would touch every inline JSX
 * call site — out of scope for math support. A standalone inline atom
 * keeps the change additive: math gets live inline rendering without
 * re-architecting `jsxInline`.
 *
 * The descriptor registry stays "all-block" — `<InlineMath>` is not a
 * registered descriptor; it maps directly to this PM node via a
 * special-case in the mdxJsxTextElement handler.
 */
export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  priority: 60,

  addAttributes() {
    return {
      formula: { default: '' },
      id: { default: null },
      // Forward-compat — reserved for future MathJax / Typst / AsciiMath
      // substrates. KaTeX-only at ship.
      language: { default: 'latex' },
      // Source `$` delimiter run captured at parse ('$' | '$$' | longer).
      // Fidelity hint only: not rendered to HTML, so clipboard copies
      // degrade to the `$$…$$` default. null = WYSIWYG-inserted.
      sourceDelimiter: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-math-inline]',
        getAttrs: (node) => {
          if (typeof node === 'string') return false;
          return {
            formula: node.getAttribute('data-formula') || '',
            id: node.getAttribute('id') || null,
            language: node.getAttribute('data-language') || 'latex',
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      {
        'data-math-inline': '',
        'data-formula': HTMLAttributes.formula,
        'data-language': HTMLAttributes.language,
        ...(HTMLAttributes.id ? { id: HTMLAttributes.id } : {}),
      },
    ];
  },

  addCommands() {
    return {
      insertMathInline:
        (formula: string) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { formula },
          });
        },
    };
  },
});
