/**
 * The text a comment quote is made of.
 *
 * ProseMirror's `textBetween` reads node CONTENT, and two shapes in this schema
 * keep their reader-visible text somewhere else:
 *
 *   - Inline atoms — wiki link, tag, image, inline math, footnote reference —
 *     hold it in attributes. They define `renderText`, but that is a TipTap
 *     concept `textBetween` never consults, and it returns a position-faithful
 *     placeholder rather than anything readable.
 *   - Promoted fences — ` ```mermaid `, ` ```math `, `$$…$$`, and the other
 *     constructs `mermaid-promoter.ts` and its siblings rewrite into an
 *     `mdxJsxFlowElement` — become a CHILDLESS `jsxComponent` carrying the
 *     source in `props`. Those are not leaves (`content: 'block*'`), so
 *     `textBetween`'s `leafText` hook does not fire for them at all.
 *
 * Both read as the empty string, which broke commenting twice over: selecting
 * one produced no quote and the composer declined to open, and selecting PROSE
 * AROUND one produced a quote with a hole in it that the anchor resolver could
 * not find in the markdown. The second is the costly half — in a wiki-style
 * document a paragraph containing a wiki link or a tag is the common case, not
 * the exotic one.
 *
 * The text each node yields is what a reader sees in its place, so a quote
 * reads as the passage did on screen. That is also what makes it resolvable:
 * the same characters sit in the markdown source, surrounded by syntax
 * `passage-match.ts` treats as elastic.
 *
 * Deliberately NOT `leafText` on the node specs. That would change
 * `textBetween` for every caller — clipboard, `getText`, the input-rule range
 * arithmetic `renderInlineObjectText` exists to keep faithful — and would still
 * miss the promoted fences, which are not leaves. Comments are the one caller
 * that wants readable text, so they ask for it explicitly and nothing else
 * moves.
 */

import type { Node as PMNode } from '@tiptap/pm/model';

function attr(node: PMNode, name: string): string {
  const value = node.attrs[name];
  return typeof value === 'string' ? value : '';
}

function prop(node: PMNode, name: string): string {
  const props = node.attrs.props;
  if (props === null || typeof props !== 'object') return '';
  const value = (props as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

/**
 * A childless `jsxComponent`'s source text.
 *
 * `children` first — a registered component's paired body, which is the text a
 * reader sees inside it. Then the named props, in the order a reader would name
 * the thing: a mermaid
 * diagram or a math block quotes as the thing itself (`graph TD; …`) rather
 * than as a fence with its delimiters, an image as its alt text, an attached
 * file as its title or its path.
 *
 * `sourceRaw` last, covering everything else — an image with no alt, MDX
 * expressions, components this schema has never heard of. It is a fallback and
 * not a floor: a wiki file embed (`![[report.pdf]]`) carries an EMPTY one, so
 * without `target` in the chain it quoted as nothing at all and its Ask AI
 * button opened a composer that immediately declined. Any construct whose
 * readable text lives in a prop belongs in this list.
 *
 * A component WITH children (a `<Callout>`) never reaches here: its text is
 * real content and the ordinary walk already collects it.
 */
const TEXT_BEARING_PROPS = [
  'children',
  'chart',
  'formula',
  'alt',
  'name',
  'alias',
  'target',
] as const;

function componentText(node: PMNode): string {
  for (const name of TEXT_BEARING_PROPS) {
    const value = prop(node, name);
    if (value.length > 0) return value;
  }
  return attr(node, 'sourceRaw');
}

/** The text `node` contributes to a quote, or `''` when it contributes none. */
export function commentLeafText(node: PMNode): string {
  switch (node.type.name) {
    // The alias when there is one — `[[page|Nice Name]]` shows "Nice Name", and
    // quoting the target instead would name something the reader cannot see.
    case 'wikiLink':
      return attr(node, 'alias') || attr(node, 'target');
    case 'wikiLinkEmbed':
      return attr(node, 'target');
    // With the `#`, which IS on screen and is part of the word a reader would
    // say they selected. It also matches the source byte-for-byte, so tags need
    // no elastic-syntax rule at all.
    case 'tag':
      return `#${attr(node, 'value')}`;
    case 'mathInline':
      return attr(node, 'formula');
    case 'image':
    case 'imageReference':
      return attr(node, 'alt');
    // The label as authored (`[^note]` → "note"), falling back to the
    // identifier remark normalizes it to.
    case 'footnoteReference':
      return attr(node, 'label') || attr(node, 'identifier');
    // Both component nodes, block and inline, on the same rule: a registered
    // descriptor's paired body is destructured into `props.children` and the
    // node is left childless, so an INLINE `<Callout>body</Callout>` had the
    // very hole this exists to close. An unregistered tag keeps its raw source
    // as real text children and never reaches here.
    case 'jsxComponent':
    case 'jsxInline':
      return node.content.size === 0 ? componentText(node) : '';
    default:
      return '';
  }
}

/**
 * `doc.textBetween(from, to, blockSeparator)`, plus the text the two shapes
 * above keep in their attributes.
 *
 * Mirrors ProseMirror's own `textBetween` — including its rule that a block
 * separator is emitted before a block that actually contributes text, never
 * leading and never doubled — because a quote whose whitespace disagrees with
 * the editor's would still anchor (the matcher is elastic about whitespace) but
 * would READ wrong in the comments panel.
 */
export function commentQuoteText(
  doc: PMNode,
  from: number,
  to: number,
  blockSeparator = '\n',
  /**
   * `inlineOnly` ignores the text a BLOCK holds in its attributes — a mermaid
   * diagram's chart, a math block's formula. Callers deciding whether the text
   * FORMATTING bar applies want this: a diagram is not prose, it owns a chrome
   * bar of its own, and bold has nothing to say about it. Callers building a
   * quote want the default, which counts everything.
   */
  { inlineOnly = false }: { inlineOnly?: boolean } = {},
): string {
  let text = '';
  let first = true;
  doc.nodesBetween(
    from,
    to,
    (node, pos) => {
      const nodeText = node.isText
        ? (node.text ?? '').slice(Math.max(from, pos) - pos, to - pos)
        : inlineOnly && node.isBlock
          ? ''
          : commentLeafText(node);
      // A textblock opens a new line whether or not it turned out to hold
      // anything — matching ProseMirror, so an empty paragraph separates its
      // neighbours here exactly as it does there. A non-textblock block earns a
      // separator only by contributing text of its own (a mermaid fence). An
      // inline atom is not a block at all and must not break the line it was
      // typed into.
      if (node.isBlock && (node.isTextblock || nodeText.length > 0) && blockSeparator) {
        if (first) first = false;
        else text += blockSeparator;
      }
      text += nodeText;
      return true;
    },
    0,
  );
  return text;
}
