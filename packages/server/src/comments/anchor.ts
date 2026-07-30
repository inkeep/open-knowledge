/**
 * Content-addressed anchoring — "remember the words, not the position."
 *
 * The durable record is the exact quoted text plus widened context; the
 * position is a fast-path hint only. Re-find runs an ordered fallback and
 * fails SAFE (flags orphaned) rather than ever guessing a wrong location. No
 * fuzzy matching: the quote is matched exactly; context only disambiguates
 * between multiple exact hits.
 */

import type { Anchor } from './types.ts';

/** Hypothesis uses 32 chars of context for web text; a reasonable markdown default. */
const DEFAULT_CONTEXT_LEN = 32;

/** A located passage as `[start, end)` — what both re-find and the create path score. */
export interface Span {
  start: number;
  end: number;
}

export type RefindResult =
  | {
      status: 'anchored';
      start: number;
      end: number;
      /**
       * The quote itself changed — the range was recovered from its surrounding
       * context, so the stored `exact` is stale and must be re-captured.
       */
      rewritten?: boolean;
    }
  | { status: 'orphaned' };

/**
 * How much the passage may grow when recovered from its brackets.
 *
 * Editing inside a commented passage is normal ("needs space" → "needs more
 * space"); replacing whole paragraphs between the same two boundaries is not,
 * and silently swallowing them would attach the comment to text nobody pointed
 * at. Generous but finite: past this, treat it as a replacement and orphan.
 */
const MAX_REWRITE_GROWTH = 4;
const REWRITE_GROWTH_FLOOR = 64;

/**
 * Build an anchor for the selection `[start, end)` against `body`. Captures the
 * exact quote plus context on each side, widening the context until
 * `prefix+exact+suffix` is a unique literal so re-find can disambiguate a
 * repeated quote. Throws on an invalid range.
 */
export function createAnchor(
  body: string,
  start: number,
  end: number,
  contextLen: number = DEFAULT_CONTEXT_LEN,
): Anchor {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > body.length ||
    start >= end
  ) {
    throw new Error(`invalid selection range [${start}, ${end}) for body length ${body.length}`);
  }
  const exact = body.slice(start, end);
  let prefix = body.slice(Math.max(0, start - contextLen), start);
  let suffix = body.slice(end, Math.min(body.length, end + contextLen));

  // Widen context only when the quote is ambiguous on its own. Grow the window
  // (capped at whole-doc) until the triple is unique; if the surrounding text
  // is genuinely identical, the position hint is the remaining tie-break.
  if (countOccurrences(body, exact) > 1) {
    let len = contextLen;
    while (!isUniqueTriple(body, prefix, exact, suffix) && len < body.length) {
      len = Math.min(len * 2, body.length);
      prefix = body.slice(Math.max(0, start - len), start);
      suffix = body.slice(end, Math.min(body.length, end + len));
    }
  }
  return { exact, prefix, suffix, start, end };
}

/**
 * Semiont "reconcile at write time": the stored quote must be exactly what sits
 * at the offsets. Route handlers call this on a client-supplied anchor before
 * persisting — a mismatch means the client measured against a different body.
 */
export function assertAnchorConsistent(body: string, anchor: Anchor): void {
  if (body.slice(anchor.start, anchor.end) !== anchor.exact) {
    throw new Error('anchor write-time invariant violated: quote does not match offsets');
  }
}

/** Every literal occurrence of `needle`, as spans. */
export function literalSpans(haystack: string, needle: string): Span[] {
  return allOccurrences(haystack, needle).map((start) => ({ start, end: start + needle.length }));
}

/**
 * Narrow candidate occurrences to the ones whose surroundings best match the
 * context a caller captured. Returns EVERY candidate tied for the best score,
 * so a caller with a further tie-break of its own can apply it — this never
 * invents one, and with no context every candidate ties and the whole set comes
 * back untouched.
 *
 * Scoring is a raw common-character run on each side, deliberately tolerant:
 * the context may have been captured against RENDERED text while `body` is
 * markdown, so an exact comparison would collapse to zero the moment a `**`
 * falls inside the window. A partial run still ranks the right occurrence first,
 * and every candidate is scored the same way.
 */
export function bestByContext<T extends Span>(
  body: string,
  hits: readonly T[],
  context: { prefix?: string; suffix?: string },
): T[] {
  const prefix = context.prefix ?? '';
  const suffix = context.suffix ?? '';
  let best: T[] = [];
  let bestScore = -1;
  for (const hit of hits) {
    const score =
      commonSuffixLen(prefix, body.slice(0, hit.start)) +
      commonPrefixLen(suffix, body.slice(hit.end));
    if (score > bestScore) {
      bestScore = score;
      best = [hit];
    } else if (score === bestScore) {
      best.push(hit);
    }
  }
  return best;
}

/**
 * Locate the anchor in the current `body`. Ordered, stop at first hit:
 *   1. fast path — the quote is still at the saved offsets;
 *   2. quote search — find the quote; disambiguate multiple hits by context,
 *      then by nearest-to-old-position;
 *   3. orphan — nothing matched, or still ambiguous. Never guesses.
 */
export function refind(body: string, anchor: Anchor): RefindResult {
  const { exact, prefix, suffix, start } = anchor;
  const end = start + exact.length;

  // (1) fast path
  if (end <= body.length && body.slice(start, end) === exact) {
    return { status: 'anchored', start, end };
  }

  // (2) quote search
  const hits = allOccurrences(body, exact);
  if (hits.length === 0) return refindBetweenBrackets(body, anchor);
  if (hits.length === 1) {
    return { status: 'anchored', start: hits[0], end: hits[0] + exact.length };
  }

  // disambiguate by how much of the stored context still surrounds each hit
  const best = bestByContext(
    body,
    hits.map((h) => ({ start: h, end: h + exact.length })),
    { prefix, suffix },
  );
  if (best.length === 1) {
    return { status: 'anchored', start: best[0].start, end: best[0].end };
  }

  // final tie-break: nearest to the old position
  let nearest: Span[] = [];
  let nearestDist = Number.POSITIVE_INFINITY;
  for (const h of best) {
    const d = Math.abs(h.start - start);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = [h];
    } else if (d === nearestDist) {
      nearest.push(h);
    }
  }
  if (nearest.length === 1) {
    return { status: 'anchored', start: nearest[0].start, end: nearest[0].end };
  }
  // genuinely ambiguous — flag, never guess
  return { status: 'orphaned' };
}

/**
 * Recover a passage whose text was EDITED rather than removed.
 *
 * The stored prefix/suffix were widened at creation until the triple was
 * unique, so when both still occur exactly once and in order, whatever sits
 * between them is the passage — whatever it now says. The boundaries stay an
 * exact match; only the middle is allowed to have changed, which is what makes
 * this different from fuzzy matching: it cannot land on an unrelated passage,
 * because the surroundings have to be literally where they were.
 *
 * Ambiguity orphans rather than guesses, per the same rule the quote search
 * follows: more than one candidate bracket means we do not know which one the
 * reviewer meant.
 */
function refindBetweenBrackets(body: string, anchor: Anchor): RefindResult {
  const { prefix, suffix, exact } = anchor;
  // An empty side means the anchor sat at that end of the document; that
  // boundary is the document edge and needs no match.
  const starts = prefix === '' ? [0] : allOccurrences(body, prefix).map((i) => i + prefix.length);
  const ends = suffix === '' ? [body.length] : allOccurrences(body, suffix);
  if (starts.length !== 1 || ends.length !== 1) return { status: 'orphaned' };

  const start = starts[0];
  const end = ends[0];
  if (end < start) return { status: 'orphaned' };
  // A passage edited down to nothing is a removal, not an edit.
  if (end === start) return { status: 'orphaned' };
  const ceiling = Math.max(exact.length * MAX_REWRITE_GROWTH, exact.length + REWRITE_GROWTH_FLOOR);
  if (end - start > ceiling) return { status: 'orphaned' };
  return { status: 'anchored', start, end, rewritten: true };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + 1);
  }
  return count;
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

function isUniqueTriple(body: string, prefix: string, exact: string, suffix: string): boolean {
  return countOccurrences(body, prefix + exact + suffix) === 1;
}

/** Length of the longest common prefix of `a` and `b`. */
function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/** Length of the longest common suffix of `a` and `b`. */
function commonSuffixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}
