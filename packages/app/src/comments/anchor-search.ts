/**
 * Shared anchor resolver — locate a comment's passage in the live document.
 *
 * Flattens the doc's text nodes into a string carrying each character's
 * ProseMirror position, then finds the quote. The quote is a slice of the
 * markdown BODY and this index is RENDERED text, so a literal search runs
 * first and a markdown-syntax-elastic search (`findAllPassages`) second — the
 * latter is what locates a passage that carries `**`, a `- `, or a `##` the
 * editor no longer shows. Neither pass is fuzzy: every rendered character must
 * still match, in order.
 *
 * A REPEATED quote is the case that matters: `indexOf` alone always returns the
 * first match, so a phrase appearing twice highlights and scrolls to the wrong
 * one. The stored `prefix`/`suffix` (widened at create time until the passage
 * was unique) disambiguate, scoring each candidate by how much surrounding
 * context still matches — literally the same `contextMatchScore` the server
 * ranks with, so the two cannot pick different occurrences of one thread. Ties
 * fall to the earliest hit on both sides.
 *
 * The server's `start`/`end` can't be used directly here: those are offsets into
 * the markdown BODY, while this index is over RENDERED text, so markdown syntax
 * characters make the two disagree. Context matching works on text content and
 * degrades gracefully when the surroundings have also changed.
 */

import {
  commentLeafText,
  commentQuoteText,
  contextMatchScore,
  findAllPassages,
  type PassageMatch,
  rewriteCeiling,
} from '@inkeep/open-knowledge-core';
import type { Node as PMNode } from '@tiptap/pm/model';

interface TextIndex {
  text: string;
  positions: number[];
}

/** The stored context around a passage, used only to disambiguate repeats. */
export interface AnchorContext {
  prefix?: string;
  suffix?: string;
}

/**
 * `includeBlockComponents` admits the text a BLOCK holds in its attributes — a
 * mermaid diagram's chart, a math block's formula.
 *
 * Off by default, and that default is load-bearing. A diagram's interior is not
 * prose: it is identifiers and edge labels that no reader is reading as part of
 * the sentence next to it, but it is full of common letter pairs. Admitting it
 * to the prose index let a short quote match INSIDE a diagram — a comment on
 * the word "hi" landed on a diagram containing "thinks", and its margin chip
 * docked beside the drawing instead of beside the sentence it was about.
 *
 * A comment ON a diagram still resolves: `findQuoteRange` retries with this on
 * once the prose pass has come up empty, so the interior is reachable only by a
 * quote that nothing in the prose could satisfy.
 */
export function buildTextIndex(
  doc: PMNode,
  { includeBlockComponents = false }: { includeBlockComponents?: boolean } = {},
): TextIndex {
  let text = '';
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) {
        text += node.text[i];
        positions.push(pos + i);
      }
      return true;
    }
    // Inline atoms carry text a reader sees but ProseMirror stores as
    // attributes — a wiki link's label, a tag, an image's alt. Those ARE part
    // of the sentence, so they belong in the prose index unconditionally;
    // quotes are captured with them (see `commentQuoteText`), and without them
    // a passage spanning one could never be highlighted here.
    if (node.isBlock && !includeBlockComponents) return true;
    const leaf = commentLeafText(node);
    if (leaf.length > 0) {
      // Every character maps to the node's own position except the last, which
      // maps to its final one — `toRange` adds 1 to the last character's
      // position, so this is what makes a hit anywhere inside resolve to the
      // WHOLE node. For a one-wide inline atom the two are the same position;
      // for a mermaid fence they are not, and mapping every character to `pos`
      // would have highlighted only the node's opening token.
      const last = pos + node.nodeSize - 1;
      for (let i = 0; i < leaf.length; i++) {
        text += leaf[i];
        positions.push(i === leaf.length - 1 ? last : pos);
      }
    }
    return true;
  });
  return { text, positions };
}

function allOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === '') return out;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

/**
 * Locate a passage whose text changed, by the context still surrounding it.
 *
 * Both brackets must match exactly once and in order; whatever sits between
 * them is the passage. Ambiguity or runaway growth declines rather than guesses
 * — the same rule the quote search follows.
 */
function findBetweenBrackets(
  text: string,
  quote: string,
  context?: AnchorContext,
): PassageMatch | null {
  const prefix = context?.prefix ?? '';
  const suffix = context?.suffix ?? '';
  // Both empty means there is no bracket to recover from.
  if (prefix === '' && suffix === '') return null;

  const starts =
    prefix === ''
      ? [0]
      : findAllPassages(text, prefix, { syntaxIn: 'needle' }).map((hit) => hit.end);
  const ends =
    suffix === ''
      ? [text.length]
      : findAllPassages(text, suffix, { syntaxIn: 'needle' }).map((hit) => hit.start);
  if (starts.length !== 1 || ends.length !== 1) return null;

  // Whitespace at the bracket seams belongs to neither side. The matcher never
  // begins a match on whitespace, so a suffix that starts with a space matches a
  // character late and the span would otherwise swallow the gap.
  let start = starts[0];
  let end = ends[0];
  while (start < end && /\s/.test(text[start] ?? '')) start += 1;
  while (end > start && /\s/.test(text[end - 1] ?? '')) end -= 1;
  if (end <= start) return null;
  const ceiling = rewriteCeiling(quote.length);
  if (end - start > ceiling) return null;
  return { start, end };
}

function toRange(index: TextIndex, hit: PassageMatch): { from: number; to: number } | null {
  const from = index.positions[hit.start];
  const to = index.positions[hit.end - 1];
  if (from == null || to == null) return null;
  return { from, to: to + 1 };
}

export function findRangeInIndex(
  index: TextIndex,
  quote: string,
  context?: AnchorContext,
): { from: number; to: number } | null {
  if (quote.length === 0) return null;
  // The stored quote is a slice of the markdown BODY, so a passage carrying any
  // formatting (`**Peanut sauce:**`, a list item's `- `) is not literally
  // present in the rendered text. Literal hits first — they're exact and the
  // common case — then the same passage with markdown syntax treated as
  // elastic.
  let hits: PassageMatch[] = allOccurrences(index.text, quote).map((at) => ({
    start: at,
    end: at + quote.length,
  }));
  if (hits.length === 0) hits = findAllPassages(index.text, quote, { syntaxIn: 'needle' });
  // Still nothing: the passage may have been EDITED rather than removed. Recover
  // it from its brackets, the same way the server's `refind` does — the server
  // only re-finds on queue/dispatch, so without this the highlight disappears
  // the moment you edit the words you commented on.
  if (hits.length === 0) {
    const recovered = findBetweenBrackets(index.text, quote, context);
    return recovered === null ? null : toRange(index, recovered);
  }
  if (hits.length === 1) return toRange(index, hits[0]);

  // Repeated quote: prefer the hit whose surrounding text best matches the
  // context captured when the comment was written.
  const prefix = context?.prefix ?? '';
  const suffix = context?.suffix ?? '';
  let best: PassageMatch[] = [];
  let bestScore = -1;
  for (const hit of hits) {
    // `index.text` is rendered text, so there is no markdown syntax to be
    // elastic about — only whitespace. Same function the server ranks with.
    const score = contextMatchScore(index.text, hit, { prefix, suffix }, { syntaxIn: 'none' });
    if (score > bestScore) {
      bestScore = score;
      best = [hit];
    } else if (score === bestScore) {
      best.push(hit);
    }
  }
  // Context could not separate them — the earliest hit, which is exactly what
  // the server's `bestByContext` caller does with the same tied set. There was
  // once a nearest-known-position tie-break here; it took the offset off a
  // stored anchor, which is measured against the markdown body, and compared it
  // to rendered positions. No caller ever had an offset in the right units, so
  // it only ever added a confident wrong answer to a genuine tie.
  return toRange(index, best[0]);
}

/**
 * How much rendered text to capture either side of a selection. Enough to
 * separate two occurrences of a passage; not so much that it carries the
 * document.
 */
const SELECTION_CONTEXT_LEN = 64;

/**
 * The rendered text immediately around `[from, to)` — what tells the server
 * WHICH occurrence was selected when the quoted words repeat.
 *
 * Without it the server can only take the first match, so commenting on the
 * second of two identical passages anchors the thread to the first, and the
 * create-time context widening then makes that wrong choice unambiguous. The
 * editor is the only place that knows which one the user actually picked, and
 * `quote` alone throws that away.
 *
 * Rendered text, like the quote it accompanies: the server scores it against
 * markdown and tolerates the difference.
 */
export function captureSelectionContext(
  doc: PMNode,
  from: number,
  to: number,
): { prefix: string; suffix: string } {
  // `commentQuoteText`, for the same reason the QUOTE uses it: `textBetween`
  // reads an inline atom as empty, so a window containing a wiki link or a tag
  // came back with a hole where the distinguishing word was. Two list items
  // reading `[[alpha]] done` and `[[beta]] done` produced the identical prefix
  // ` done\n `, and the comment on the second anchored to the first — the same
  // failure the quote fix closed, one field over.
  return {
    prefix: commentQuoteText(doc, Math.max(0, from - SELECTION_CONTEXT_LEN), from),
    suffix: commentQuoteText(doc, to, Math.min(doc.content.size, to + SELECTION_CONTEXT_LEN)),
  };
}

export function findQuoteRange(
  doc: PMNode,
  quote: string,
  context?: AnchorContext,
): { from: number; to: number } | null {
  return createAnchorResolver(doc)(quote, context);
}

/**
 * Resolve many quotes against one document.
 *
 * Callers place every open thread in a single pass, on every scroll frame and
 * every edit, so the indexes are built once for the pass rather than once per
 * thread — walking a 100k-character document per comment was measured at about
 * twenty times the cost.
 *
 * Two passes per quote, prose first (see `buildTextIndex` for why the order is
 * the protection). The component index is built lazily: a document whose
 * comments all land in prose — nearly all of them — never pays for it.
 */
export function createAnchorResolver(
  doc: PMNode,
): (quote: string, context?: AnchorContext) => { from: number; to: number } | null {
  const prose = buildTextIndex(doc);
  let components: TextIndex | null = null;
  return (quote, context) => {
    const inProse = findRangeInIndex(prose, quote, context);
    if (inProse !== null) return inProse;
    components ??= buildTextIndex(doc, { includeBlockComponents: true });
    return findRangeInIndex(components, quote, context);
  };
}
