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
 * was unique) disambiguate, mirroring how the server re-finds it — score each
 * candidate by how much surrounding context still matches, then fall back to
 * whichever sits nearest the last known position.
 *
 * The server's `start`/`end` can't be used directly here: those are offsets into
 * the markdown BODY, while this index is over RENDERED text, so markdown syntax
 * characters make the two disagree. Context matching works on text content and
 * degrades gracefully when the surroundings have also changed.
 */

import { findAllPassages, type PassageMatch } from '@inkeep/open-knowledge-core';
import type { Node as PMNode } from '@tiptap/pm/model';

interface TextIndex {
  text: string;
  positions: number[];
}

/** The stored context around a passage, used only to disambiguate repeats. */
export interface AnchorContext {
  prefix?: string;
  suffix?: string;
  /** Last known offset — a weak final tie-break when context can't separate hits. */
  start?: number;
}

export function buildTextIndex(doc: PMNode): TextIndex {
  let text = '';
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) {
        text += node.text[i];
        positions.push(pos + i);
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

/** Length of the longest common suffix of `a` and `b`. */
function commonSuffixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

/** Length of the longest common prefix of `a` and `b`. */
function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/**
 * How much the passage may grow when recovered from its brackets.
 *
 * DRIFT WARNING: mirrors `MAX_REWRITE_GROWTH` / `REWRITE_GROWTH_FLOOR` in the
 * server's `anchor.ts`. The two run on different substrates — rendered text here,
 * the markdown body there — so they cannot share an implementation, but they
 * must agree on the policy or a passage recovers in the document and orphans on
 * dispatch, or the reverse.
 */
const MAX_REWRITE_GROWTH = 4;
const REWRITE_GROWTH_FLOOR = 64;

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
  const ceiling = Math.max(quote.length * MAX_REWRITE_GROWTH, quote.length + REWRITE_GROWTH_FLOOR);
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
    const score =
      commonSuffixLen(prefix, index.text.slice(0, hit.start)) +
      commonPrefixLen(suffix, index.text.slice(hit.end));
    if (score > bestScore) {
      bestScore = score;
      best = [hit];
    } else if (score === bestScore) {
      best.push(hit);
    }
  }
  if (best.length === 1) return toRange(index, best[0]);

  // Context couldn't separate them — take the one nearest the last known
  // position. Body and rendered offsets aren't identical, but both advance
  // monotonically through the document, so "nearest" still orders correctly.
  const hint = context?.start;
  if (hint === undefined) return toRange(index, best[0]);
  let nearest = best[0];
  let nearestDist = Number.POSITIVE_INFINITY;
  for (const hit of best) {
    const dist = Math.abs(hit.start - hint);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = hit;
    }
  }
  return toRange(index, nearest);
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
  return {
    prefix: doc.textBetween(Math.max(0, from - SELECTION_CONTEXT_LEN), from, '\n'),
    suffix: doc.textBetween(to, Math.min(doc.content.size, to + SELECTION_CONTEXT_LEN), '\n'),
  };
}

export function findQuoteRange(
  doc: PMNode,
  quote: string,
  context?: AnchorContext,
): { from: number; to: number } | null {
  return findRangeInIndex(buildTextIndex(doc), quote, context);
}
