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
    const shifted = `PADDING PADDING ${dup}`;
    const res = refind(shifted, a);
    expect(res.status).toBe('anchored');
    if (res.status === 'anchored') {
      expect(shifted.slice(res.start, res.end)).toBe('TARGET');
      expect(shifted.slice(0, res.start).endsWith('alpha ')).toBe(true);
    }
  });

  test('never lands on the wrong words: prefers nearest when context ties', () => {
    const line = 'x TARGET y x TARGET y';
    const first = line.indexOf('TARGET');
    const second = line.indexOf('TARGET', first + 1);
    const a = createAnchor(line, second, second + 'TARGET'.length, 2);
    const res = refind(line, a);
    expect(res).toEqual({ status: 'anchored', start: second, end: second + 'TARGET'.length });
  });
});

describe('refind — a deleted passage with an identical twin elsewhere', () => {
  const doc =
    'The northern site reports TARGET PHRASE beside the river delta. ' +
    'Unrelated closing notes mention TARGET PHRASE near the archive vault.';

  test('orphans instead of sliding onto the surviving twin', () => {
    const first = doc.indexOf('TARGET PHRASE');
    const a = createAnchor(doc, first, first + 'TARGET PHRASE'.length);
    const afterDelete = doc.slice(doc.indexOf('Unrelated'));
    const res = refind(afterDelete, a);
    expect(res.status).toBe('orphaned');
  });

  test('still follows the commented occurrence when it is the one that survives', () => {
    const second = doc.indexOf('TARGET PHRASE', doc.indexOf('TARGET PHRASE') + 1);
    const a = createAnchor(doc, second, second + 'TARGET PHRASE'.length);
    const afterDelete = doc.slice(doc.indexOf('Unrelated'));
    const res = refind(afterDelete, a);
    expect(res.status).toBe('anchored');
    if (res.status === 'anchored') {
      expect(afterDelete.slice(res.start, res.end)).toBe('TARGET PHRASE');
      expect(afterDelete.slice(0, res.start).endsWith('mention ')).toBe(true);
    }
  });

  test('a unique passage whose surroundings were rewritten is still followed', () => {
    const body = 'Alpha beta gamma UNIQUE WORDS delta epsilon zeta.';
    const at = body.indexOf('UNIQUE WORDS');
    const a = createAnchor(body, at, at + 'UNIQUE WORDS'.length);
    const edited = 'Alpha beta gamma UNIQUE WORDS delta and considerably more text.';
    const res = refind(edited, a);
    expect(res.status).toBe('anchored');
    if (res.status === 'anchored') {
      expect(edited.slice(res.start, res.end)).toBe('UNIQUE WORDS');
    }
  });
});

describe('refind — deleting the selection leaves a seam', () => {
  const sentence = 'The chord stages into the agents panel specifically, naming its target.';
  const body = `Intro paragraph first. ${sentence} Later, the decision restates it: ${sentence}`;

  test('orphans on the seam even though the twin matches the context honestly', () => {
    const first = body.indexOf('the agents panel');
    const a = createAnchor(body, first, first + 'the agents panel'.length);
    const afterDelete = body.slice(0, first) + body.slice(first + 'the agents panel'.length);
    const res = refind(afterDelete, a);
    expect(res.status).toBe('orphaned');
  });

  test('typing into the seam is an edit again, not a deletion', () => {
    const unique = 'Setup text sits here. The chord stages into the agents panel today. Done.';
    const at = unique.indexOf('the agents panel');
    const a = createAnchor(unique, at, at + 'the agents panel'.length);
    const rewritten = `${unique.slice(0, at)}the sessions dock${unique.slice(at + 'the agents panel'.length)}`;
    const res = refind(rewritten, a);
    expect(res.status).toBe('anchored');
    if (res.status === 'anchored') {
      expect(rewritten.slice(res.start, res.end)).toBe('the sessions dock');
      expect(res.rewritten).toBe(true);
    }
  });
});

describe('refind — a passage that was edited, not removed', () => {
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
    const edited = BODY.replace('needs space ', '');
    const result = refind(edited, anchor);
    expect(result.status).toBe('orphaned');
  });

  test('refuses to swallow a wholesale replacement between the brackets', () => {
    const anchor = anchorOn('needs space');
    const huge = 'x'.repeat(500);
    const edited = BODY.replace('needs space', huge);
    expect(refind(edited, anchor).status).toBe('orphaned');
  });

  test('orphans rather than guessing when the brackets are ambiguous', () => {
    const anchor = { exact: 'mid', prefix: 'X ', suffix: ' Y', start: 2, end: 5 };
    const edited = 'X changed Y and later X other Y';

    expect(refind(edited, anchor).status).toBe('orphaned');
  });

  test('a repeated quote edited in one place does not drag the comment elsewhere', () => {
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

describe('bestByContext across a block seam', () => {
  const BODY = ['- hi', '- hi', '- hi', '', 'the marker paragraph', '', '- hi', '- hi'].join('\n');

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

describe('refind — a passage whose NEIGHBOURS were edited', () => {
  const BODY = [
    '## Steps',
    '',
    '1. Toss the chicken with the coconut milk and curry powder. Rest 15 minutes.',
    '2. Thread onto skewers if using.',
    '3. Sear in a hot grill pan until charred.',
  ].join('\n');
  const QUOTE = 'Toss the chicken with the coconut milk and curry powder. Rest 15 minutes.';

  function anchorOn(body = BODY) {
    const at = body.indexOf(QUOTE);
    return createAnchor(body, at, at + QUOTE.length);
  }

  function editedFar(...edits: readonly (readonly [string, string])[]): string {
    return edits.reduce((body, [from, to]) => body.replace(from, to), `Intro.\n\n${BODY}`);
  }

  function expectResolvesTo(edited: string) {
    const result = refind(edited, anchorOn());
    expect(result.status).toBe('anchored');
    if (result.status !== 'anchored') return;
    expect(edited.slice(result.start, result.end)).toBe(QUOTE);
  }

  test('the passage still resolves when the item after it is truncated', () => {
    expectResolvesTo(editedFar(['2. Thread onto skewers if using.', '2. Thread onto ske']));
  });

  test('the passage still resolves when the heading above it is rewritten', () => {
    expectResolvesTo(editedFar(['## Steps', '## Method here']));
  });

  test('a distant edit alone does not disturb it', () => {
    expectResolvesTo(editedFar());
  });
});
