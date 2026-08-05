import { describe, expect, test } from 'vitest';
import {
  assertAnchorConsistent,
  bestByContext,
  createAnchor,
  literalSpans,
  refind,
} from './anchor.ts';

describe('createAnchor', () => {
  test('captures the exact quote and surrounding context', () => {
    const body = 'The rollout is scheduled for Q3. We expect minimal downtime.';
    const start = body.indexOf('minimal downtime');
    const anchor = createAnchor(body, start, start + 'minimal downtime'.length);
    expect(anchor.exact).toBe('minimal downtime');
    expect(body.slice(anchor.start, anchor.end)).toBe('minimal downtime');
    expect(anchor.prefix.endsWith('We expect ')).toBe(true);
    expect(anchor.suffix.startsWith('.')).toBe(true);
  });

  test('honors the requested context length', () => {
    const body = 'abcdefghij TARGET klmnopqrst';
    const start = body.indexOf('TARGET');
    const anchor = createAnchor(body, start, start + 'TARGET'.length, 4);
    expect(anchor.exact).toBe('TARGET');
    expect(anchor.prefix).toBe(body.slice(start - 4, start));
    expect(anchor.suffix).toBe(body.slice(start + 6, start + 6 + 4));
    expect(anchor.prefix.length).toBe(4);
    expect(anchor.suffix.length).toBe(4);
  });

  test('widens context until a repeated quote is a unique triple', () => {
    const body = 'alpha X beta. gamma X delta.';
    // "X" appears twice; a 1-char context must widen to disambiguate.
    const first = body.indexOf('X');
    const anchor = createAnchor(body, first, first + 1, 1);
    const triple = anchor.prefix + anchor.exact + anchor.suffix;
    const occurrences = body.split(triple).length - 1;
    expect(occurrences).toBe(1);
  });

  test('rejects an invalid range', () => {
    const body = 'short';
    expect(() => createAnchor(body, 3, 3)).toThrow();
    expect(() => createAnchor(body, -1, 2)).toThrow();
    expect(() => createAnchor(body, 2, 99)).toThrow();
  });
});

describe('assertAnchorConsistent', () => {
  test('passes when the quote matches the offsets', () => {
    const body = 'hello world';
    const anchor = createAnchor(body, 6, 11);
    expect(() => assertAnchorConsistent(body, anchor)).not.toThrow();
  });

  test('throws when the client measured against a different body', () => {
    const body = 'hello world';
    const stale = { exact: 'world', prefix: '', suffix: '', start: 0, end: 5 };
    expect(() => assertAnchorConsistent(body, stale)).toThrow(/write-time invariant/);
  });
});

describe('refind', () => {
  const body = 'The rollout is scheduled for Q3. We expect minimal downtime.';
  const start = body.indexOf('minimal downtime');
  const anchor = createAnchor(body, start, start + 'minimal downtime'.length);

  test('fast path: unchanged body returns the same offsets', () => {
    const res = refind(body, anchor);
    expect(res).toEqual({ status: 'anchored', start, end: start + 'minimal downtime'.length });
  });

  test('re-finds after text is inserted above the anchor (position drifted)', () => {
    const shifted = `Heads up: dates may slip. ${body}`;
    const res = refind(shifted, anchor);
    expect(res.status).toBe('anchored');
    if (res.status === 'anchored') {
      expect(shifted.slice(res.start, res.end)).toBe('minimal downtime');
      // the raw saved offsets would have pointed at the wrong words
      expect(res.start).not.toBe(anchor.start);
    }
  });

  test('orphans when the quoted text is gone', () => {
    const rewritten = 'The rollout is scheduled for Q3. Everything is fine now.';
    expect(refind(rewritten, anchor).status).toBe('orphaned');
  });

  test('disambiguates a repeated quote by surrounding context', () => {
    const dup = 'alpha TARGET omega ... beta TARGET zeta';
    const first = dup.indexOf('TARGET');
    const a = createAnchor(dup, first, first + 'TARGET'.length, 6);
    // Insert text above so the fast path misses and quote-search runs.
    const shifted = `PADDING PADDING ${dup}`;
    const res = refind(shifted, a);
    expect(res.status).toBe('anchored');
    if (res.status === 'anchored') {
      // should land on the FIRST occurrence (its context matches "alpha ")
      expect(shifted.slice(res.start, res.end)).toBe('TARGET');
      expect(shifted.slice(0, res.start).endsWith('alpha ')).toBe(true);
    }
  });

  test('never lands on the wrong words: prefers nearest when context ties', () => {
    // identical context around two hits → nearest-to-old-position wins
    const line = 'x TARGET y x TARGET y';
    const first = line.indexOf('TARGET');
    const second = line.indexOf('TARGET', first + 1);
    const a = createAnchor(line, second, second + 'TARGET'.length, 2);
    const res = refind(line, a);
    // fast path hits (unchanged body) → exact same offsets
    expect(res).toEqual({ status: 'anchored', start: second, end: second + 'TARGET'.length });
  });
});

describe('refind — a passage that was edited, not removed', () => {
  // The reported behaviour: commenting on "needs space", then editing it to
  // "needs more space", dropped the comment. Editing the text you commented on
  // is the likeliest next action, so orphaning there was backwards.
  const BODY = 'Intro line.\n\nThe layout needs space around the header.\n\nOutro line.';

  function anchorOn(quote: string, body = BODY) {
    const at = body.indexOf(quote);
    return createAnchor(body, at, at + quote.length);
  }

  test('follows an insertion inside the passage', () => {
    const anchor = anchorOn('needs space');
    const edited = BODY.replace('needs space', 'needs more space');

    const result = refind(edited, anchor);
    expect(result.status).toBe('anchored');
    if (result.status !== 'anchored') return;
    expect(edited.slice(result.start, result.end)).toBe('needs more space');
    // Flagged so the caller re-captures the quote; a stale `exact` would be
    // handed to an agent as text to act on.
    expect(result.rewritten).toBe(true);
  });

  test('follows a deletion inside the passage', () => {
    const anchor = anchorOn('needs space around');
    const edited = BODY.replace('needs space around', 'needs space near');

    const result = refind(edited, anchor);
    expect(result.status).toBe('anchored');
    if (result.status !== 'anchored') return;
    expect(edited.slice(result.start, result.end)).toBe('needs space near');
  });

  test('an unchanged passage still takes the exact path, unflagged', () => {
    const result = refind(BODY, anchorOn('needs space'));
    expect(result.status).toBe('anchored');
    if (result.status !== 'anchored') return;
    expect(result.rewritten).toBeUndefined();
  });

  test('a passage deleted outright still orphans', () => {
    const anchor = anchorOn('needs space');
    // Brackets collapse together — nothing between them is a removal, not an edit.
    const edited = BODY.replace('needs space ', '');
    const result = refind(edited, anchor);
    expect(result.status).toBe('orphaned');
  });

  test('refuses to swallow a wholesale replacement between the brackets', () => {
    const anchor = anchorOn('needs space');
    const huge = 'x'.repeat(500);
    const edited = BODY.replace('needs space', huge);
    // The boundaries still match, but growing 11 chars to 500 is a replacement.
    expect(refind(edited, anchor).status).toBe('orphaned');
  });

  test('orphans rather than guessing when the brackets are ambiguous', () => {
    // Brackets that repeat cannot identify which span the reviewer meant, so
    // the bracket path declines instead of picking one. Constructed directly:
    // via `createAnchor` the context would widen until unique, which is exactly
    // what keeps this case rare in practice.
    const anchor = { exact: 'mid', prefix: 'X ', suffix: ' Y', start: 2, end: 5 };
    const edited = 'X changed Y and later X other Y';

    expect(refind(edited, anchor).status).toBe('orphaned');
  });

  test('a repeated quote edited in one place does not drag the comment elsewhere', () => {
    // The exact text still exists at the other occurrences, so the pre-existing
    // quote search handles it — the bracket path never runs. Pinned because the
    // two paths must not fight: whatever it picks has to be real text.
    const repeated = 'The layout needs space around the header.\n'.repeat(3);
    const at = repeated.indexOf('needs space');
    const anchor = createAnchor(repeated, at, at + 'needs space'.length);
    const edited = repeated.replace('needs space', 'needs more space');

    const result = refind(edited, anchor);
    if (result.status === 'anchored') {
      expect(edited.slice(result.start, result.end)).toBe('needs space');
    }
  });
});

/**
 * Ranking a repeated passage whose only distinguishing context is in an
 * adjacent block.
 *
 * The captured context joins blocks with a single `\n`; the body separates them
 * with `\n\n` and spends `- ` on every list item. Scored byte-exact, that
 * disagreed at the first seam character and returned zero for every candidate,
 * so the ranking was inert and the caller took the first hit — persisting a
 * comment on the third item against the first.
 */
describe('bestByContext across a block seam', () => {
  const BODY = ['- hi', '- hi', '- hi', '', 'the marker paragraph', '', '- hi', '- hi'].join('\n');

  /** `[start, end)` of the nth (1-based) list item's text. */
  function nth(n: number): number {
    let at = -1;
    for (let i = 0; i < n; i += 1) at = BODY.indexOf('- hi', at + 1);
    return at + 2;
  }

  test('the fixture really does repeat (guards the guard)', () => {
    expect(literalSpans(BODY, 'hi').length).toBe(5);
  });

  test('ranks the item whose SUFFIX reaches the marker block', () => {
    const hits = literalSpans(BODY, 'hi');
    const ranked = bestByContext(BODY, hits, {
      prefix: 'hi\nhi\n',
      suffix: '\nthe marker paragraph\nhi\nhi',
    });
    expect(ranked[0]?.start).toBe(nth(3));
  });

  test('ranks the item whose PREFIX reaches the marker block', () => {
    const hits = literalSpans(BODY, 'hi');
    const ranked = bestByContext(BODY, hits, {
      prefix: 'hi\nhi\nhi\nthe marker paragraph\n',
      suffix: '\nhi',
    });
    expect(ranked[0]?.start).toBe(nth(4));
  });

  test('markdown emphasis inside the window is tolerated too', () => {
    const body = ['- hi', '- hi', '', 'a **bold** marker', '', '- hi'].join('\n');
    const hits = literalSpans(body, 'hi');
    const ranked = bestByContext(body, hits, {
      prefix: 'hi\n',
      suffix: '\na bold marker\nhi',
    });
    let at = body.indexOf('- hi');
    at = body.indexOf('- hi', at + 1);
    expect(ranked[0]?.start).toBe(at + 2);
  });
});
