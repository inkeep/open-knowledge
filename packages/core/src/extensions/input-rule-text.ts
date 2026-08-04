/**
 * The text a non-text inline node contributes when the input-rule runner
 * derives the string it matches rules against.
 *
 * `@tiptap/core` builds that string by concatenating one chunk per node before
 * the caret, then computes the replacement range as pure arithmetic:
 * `from - (match[0].length - text.length)`. That arithmetic is correct only
 * while every node contributes exactly as many characters as it occupies
 * document positions, and two node shapes break it:
 *
 *  - A leaf with no text falls back to the literal `"%leaf%"` — six characters
 *    for one position. A rule whose body spans one computes a range five
 *    positions too far left: far enough to land before the document start and
 *    throw `RangeError` out of `handleTextInput`, crashing the keystroke, or —
 *    when enough text precedes it to keep the range positive — to silently
 *    rewrite the wrong span.
 *  - A node with children is skewed the other way, and by an amount that varies
 *    with its content: the runner reads the wrapper AND descends into it, so
 *    the children's text is counted twice while the wrapper's own two positions
 *    are counted not at all.
 *
 * Both are one defect — a node's contributed length must equal the positions it
 * owns — so one rule fixes both: contribute a placeholder per structural
 * position and let the children speak for themselves.
 */

import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * U+FFFC OBJECT REPLACEMENT CHARACTER — Unicode's stand-in for an embedded
 * object in a text stream, and exactly one UTF-16 unit wide, which is the unit
 * `match[0].length` counts in.
 *
 * Preferred over an ASCII filler because it cannot collide with a delimiter a
 * rule matches on, and over the empty string because the runner treats a falsy
 * chunk as absent and falls back to `"%leaf%"`.
 *
 * It also gives rule authors a lever they did not have: a rule that must not
 * match across an embedded object can exclude this character from its body.
 */
export const INLINE_OBJECT_PLACEHOLDER = '\uFFFC';

/**
 * `renderText` for an inline node that is not itself text.
 *
 * Returns one placeholder per position the node owns outside its content — one
 * for a leaf, two (open + close) for a node with children. Deriving that count
 * from the node instead of hard-coding it per extension is what lets every
 * inline node share one implementation, and what keeps the count right if a
 * node's shape changes later.
 *
 * For a node with children the placeholders lead rather than bracket the
 * content, because the runner appends the wrapper's chunk before descending.
 * Only the total length feeds the range arithmetic, so that ordering is inert
 * there; it is visible to a rule that matches across such a node, which is a
 * separate question from the one this module answers.
 */
export function renderInlineObjectText({ node }: { node: PMNode }): string {
  return INLINE_OBJECT_PLACEHOLDER.repeat(node.nodeSize - node.content.size);
}
