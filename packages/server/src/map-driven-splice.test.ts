import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { computeMapDrivenBodySplice, createEditorMdastMemo } from './map-driven-splice.ts';
import { createCountingManager } from './parse-counting.test-helper.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

function applySplice(
  oldBody: string,
  splice: { spliceStart: number; spliceEnd: number; newSlice: string },
): string {
  return oldBody.slice(0, splice.spliceStart) + splice.newSlice + oldBody.slice(splice.spliceEnd);
}

function pmFromMd(md: string): JSONContent {
  return mdManager.parse(md);
}

describe('computeMapDrivenBodySplice', () => {
  describe('byte preservation outside the splice', () => {
    test('single-block edit produces splice covering only the edited block', () => {
      const oldBody = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';
      const newBody = '# Heading\n\nFirst paragraph EDITED.\n\nSecond paragraph.\n';

      const splice = computeMapDrivenBodySplice(oldBody, pmFromMd(newBody), mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const headingEnd = oldBody.indexOf('# Heading') + '# Heading'.length;
      expect(splice.spliceStart).toBeGreaterThanOrEqual(headingEnd);
      const secondParaStart = oldBody.indexOf('Second paragraph');
      expect(splice.spliceEnd).toBeLessThanOrEqual(secondParaStart);

      expect(oldBody.slice(0, splice.spliceStart)).toBe(
        applySplice(oldBody, splice).slice(0, splice.spliceStart),
      );
      const reconstructed = applySplice(oldBody, splice);
      expect(reconstructed.slice(splice.spliceStart + splice.newSlice.length)).toBe(
        oldBody.slice(splice.spliceEnd),
      );
    });

    test('result of applying splice equals the canonical newBody serialization', () => {
      const oldBody = '# Heading\n\nFirst.\n\nSecond.\n';
      const newPm = pmFromMd('# Heading\n\nFirst CHANGED.\n\nSecond.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPm, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const reconstructed = applySplice(oldBody, splice);
      const canonicalNew = mdManager.serialize(newPm);
      const reconstructedMdast = mdManager.parseToMdast(reconstructed);
      const canonicalMdast = mdManager.parseToMdast(canonicalNew);
      expect(reconstructedMdast.children.length).toBe(canonicalMdast.children.length);
    });
  });

  describe('source-form preservation through structural equality', () => {
    test('an untouched block whose canonical form would canonicalize bytes is excluded from splice', () => {
      const oldBody = '*italic one*\n\nuntouched two\n';
      const newPmJson = pmFromMd('*italic one* EDIT\n\nuntouched two\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result).toContain('untouched two');
      const oldUntouched = oldBody.slice(oldBody.indexOf('untouched two'));
      const newUntouched = result.slice(result.indexOf('untouched two'));
      expect(newUntouched).toBe(oldUntouched);
    });

    test('block matching the structural shape but canonicalized in newBody is NOT spliced', () => {
      const oldBody = '*italic*\n\nplain\n';
      const newPmJson = pmFromMd('*italic*\n\nplain CHANGED\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result.startsWith('*italic*\n\n')).toBe(true);
    });
  });

  describe('insertions and deletions at boundaries', () => {
    test('append a new paragraph at end', () => {
      const oldBody = 'First.\n';
      const newPmJson = pmFromMd('First.\n\nSecond.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result).toContain('First.');
      expect(result).toContain('Second.');
      expect(result.indexOf('First.')).toBe(0);
    });

    test('prepend a new paragraph at start', () => {
      const oldBody = 'Second.\n';
      const newPmJson = pmFromMd('First.\n\nSecond.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result).toContain('First.');
      expect(result).toContain('Second.');
      expect(result.indexOf('First.')).toBeLessThan(result.indexOf('Second.'));
    });

    test('insert a paragraph in the middle preserves surrounding blocks byte-identically', () => {
      const oldBody = '*Pre*\n\nPost.\n';
      const newPmJson = pmFromMd('*Pre*\n\nMiddle.\n\nPost.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result.startsWith('*Pre*')).toBe(true);
      expect(result).toContain('Middle.');
      expect(result.endsWith('Post.\n')).toBe(true);
    });

    test('delete a middle block', () => {
      const oldBody = 'A.\n\nB.\n\nC.\n';
      const newPmJson = pmFromMd('A.\n\nC.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result).toContain('A.');
      expect(result).toContain('C.');
      expect(result).not.toContain('B.');
    });
  });

  describe('synthetic / empty inputs', () => {
    test('empty oldBody + new content produces splice that yields the new content', () => {
      const oldBody = '';
      const newPmJson = pmFromMd('A new paragraph.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result).toContain('A new paragraph.');
    });

    test('no-change input produces no-op splice', () => {
      const oldBody = 'A.\n\nB.\n';
      const newPmJson = pmFromMd(oldBody);
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      const oldChildren = mdManager.parseToMdast(oldBody).children;
      const resultChildren = mdManager.parseToMdast(result).children;
      expect(resultChildren.length).toBe(oldChildren.length);
    });
  });

  describe('contiguous multi-block edits', () => {
    test('editing two adjacent blocks unions their splice ranges', () => {
      const oldBody = 'first.\n\nsecond.\n\nthird.\n';
      const newPmJson = pmFromMd('first EDITED.\n\nsecond EDITED.\n\nthird.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result.endsWith('third.\n')).toBe(true);

      const thirdStartOld = oldBody.indexOf('third.');
      expect(splice.spliceEnd).toBeLessThanOrEqual(thirdStartOld);
    });

    test('non-contiguous multi-block edits collapse into one over-wide splice (documented AC2 degradation)', () => {
      const oldBody = 'first.\n\nmiddle.\n\nthird.\n';
      const newPmJson = pmFromMd('first EDITED.\n\nmiddle.\n\nthird EDITED.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const middleStart = oldBody.indexOf('middle.');
      expect(splice.spliceStart).toBeLessThanOrEqual(middleStart);
      expect(splice.spliceEnd).toBeGreaterThanOrEqual(middleStart + 'middle.'.length);

      const result = applySplice(oldBody, splice);
      expect(result).toContain('first EDITED.');
      expect(result).toContain('middle.');
      expect(result).toContain('third EDITED.');
    });
  });

  describe('robustness to parse failure', () => {
    test('returns null when serialize throws on schema-rejected JSON', () => {
      const oldBody = 'A.\n';
      const malformed = { type: 'not-a-real-node-type' } as JSONContent;
      const splice = computeMapDrivenBodySplice(oldBody, malformed, mdManager);
      expect(splice).toBeNull();
    });
  });
});

describe('editor-mdast parse memo (PRD-8273)', () => {
  test('a repeated body is parsed once, not once per call', () => {
    const { manager: counted, parses } = createCountingManager();
    const memo = createEditorMdastMemo();
    const bodyA = '# H\n\nalpha\n';

    // Drain 1: old=A, new=B. Drain 2 then arrives with old=B.
    const first = computeMapDrivenBodySplice(
      bodyA,
      counted.parse('# H\n\nalphaX\n'),
      counted,
      undefined,
      memo,
    );
    expect(first).not.toBeNull();
    if (!first) return;
    const bodyB = applySplice(bodyA, first);
    const afterFirst = parses();

    computeMapDrivenBodySplice(bodyB, counted.parse('# H\n\nalphaXY\n'), counted, undefined, memo);

    // Drain 2 parsed only its own `newBody`; `bodyB` came from the memo.
    expect(parses() - afterFirst).toBe(1);
  });

  /**
   * The memo's entire safety argument is that its key is the body BYTES. An
   * external write, a reconnect resync, or a concurrent client can change the
   * body between drains; a memo that served its cached tree there would splice
   * against a document that no longer exists — silent content corruption, far
   * worse than the latency the memo saves. So: prime it, then hand it a
   * DIFFERENT body and assert the splice is computed against the bytes
   * actually passed in.
   */
  test('a body changed out from under the memo misses rather than serving a stale parse', () => {
    const { manager: counted, parses } = createCountingManager();
    const memo = createEditorMdastMemo();

    // Prime: this call leaves the memo holding the canonical newBody.
    const primed = '# H\n\nalpha\n';
    computeMapDrivenBodySplice(primed, counted.parse('# H\n\nalphaX\n'), counted, undefined, memo);
    const afterPrime = parses();

    // A concurrent writer replaced the body wholesale. Same doc, different bytes.
    const external = '# DIFFERENT\n\nomega\n\ntail\n';
    const splice = computeMapDrivenBodySplice(
      external,
      counted.parse('# DIFFERENT\n\nomega EDITED\n\ntail\n'),
      counted,
      undefined,
      memo,
    );
    expect(splice).not.toBeNull();
    if (!splice) return;

    // It re-parsed both sides — no stale hit.
    expect(parses() - afterPrime).toBe(2);

    // And the splice is anchored in the EXTERNAL bytes: applying it reproduces
    // the intended body, and the untouched tail survives byte-identically.
    const result = applySplice(external, splice);
    expect(result).toContain('omega EDITED');
    expect(result).toContain('# DIFFERENT');
    expect(result.endsWith('tail\n')).toBe(true);
  });

  /**
   * The equivalence that matters is "a splice built from a memo HIT equals one
   * built from a fresh parse". Passing a FRESH memo does not test that: both
   * of its lookups miss, so the memoized call runs the identical cold path as
   * the unmemoized one and the comparison asserts nothing about the memo. This
   * test therefore primes the memo first and PROVES the hit landed — via the
   * parse count — before comparing. Without that assertion the test could
   * silently decay back into comparing two cold paths.
   */
  test('a splice built from a memo hit equals one built from a fresh parse', () => {
    const { manager: counted, parses } = createCountingManager();
    const memo = createEditorMdastMemo();
    const bodyA = '# H\n\none\n\ntwo\n\nthree\n';

    // Drain 1 primes the memo: the `newBody` it parses is the byte-identical
    // `oldBody` that drain 2 arrives with.
    const first = computeMapDrivenBodySplice(
      bodyA,
      counted.parse('# H\n\none EDITED\n\ntwo\n\nthree\n'),
      counted,
      undefined,
      memo,
    );
    expect(first).not.toBeNull();
    if (!first) return;
    const bodyB = applySplice(bodyA, first);

    // Drain 2: `oldBody` is served from the memo, `newBody` is parsed fresh.
    const newPm = counted.parse('# H\n\none EDITED\n\ntwo CHANGED\n\nthree\n');
    const before = parses();
    const fromHit = computeMapDrivenBodySplice(bodyB, newPm, counted, undefined, memo);
    // ONE parse, not two — this is the assertion that makes the comparison
    // below meaningful rather than tautological.
    expect(parses() - before).toBe(1);

    const fromFreshParse = computeMapDrivenBodySplice(bodyB, newPm, counted);
    expect(fromHit).toEqual(fromFreshParse);
    expect(fromHit).not.toBeNull();
  });

  /**
   * Pins the precondition the docblock states: the hit depends on the
   * preserved region's bytes being what the serializer would emit. Trailing
   * whitespace survives the splice into Y.Text but is stripped from `newBody`,
   * so the next drain's `oldBody` is NOT the previous `newBody` and must
   * re-parse. Documented behaviour, so it gets a test rather than only a
   * sentence — a stated precondition nobody exercises is how the sentence
   * drifts away from the code.
   */
  test('preserved bytes the serializer would not emit cause the next drain to miss', () => {
    const { manager: counted, parses } = createCountingManager();
    const memo = createEditorMdastMemo();
    // The trailing run on `one` is preserved by the splice, absent from newBody.
    const bodyA = 'one   \n\ntwo\n\nthree\n';

    const first = computeMapDrivenBodySplice(
      bodyA,
      counted.parse('one   \n\ntwo A\n\nthree\n'),
      counted,
      undefined,
      memo,
    );
    expect(first).not.toBeNull();
    if (!first) return;
    const bodyB = applySplice(bodyA, first);

    const before = parses();
    computeMapDrivenBodySplice(
      bodyB,
      counted.parse('one   \n\ntwo B\n\nthree\n'),
      counted,
      undefined,
      memo,
    );
    // Two parses: the memo held the canonical newBody, not these bytes.
    expect(parses() - before).toBe(2);
  });

  /**
   * The safety argument for this memo is that it keys on the body BYTES, so a
   * changed body is a different key and therefore a miss. A same-length,
   * different-content body is the one input shape that separates a genuine byte
   * comparison from a length check — or from any other shortcut that happens to
   * satisfy the other tests. The two fixtures below are byte-equal in length and
   * differ in block STRUCTURE (three paragraphs vs two), so a length-based
   * comparison would serve the wrong tree and compute a splice anchored in the
   * wrong block boundaries.
   */
  test('a same-length body with different content misses — the key is bytes, not length', () => {
    const { manager: counted, parses } = createCountingManager();
    const memo = createEditorMdastMemo();

    // A call leaves the memo holding that call's `newBody`, so the primed key
    // is DERIVED from the serializer rather than assumed to equal a literal.
    const primed = counted.serialize(counted.parse('one\n\ntwo\n\nthree\n'));
    // A different body of the same byte length, with different block structure
    // (two paragraphs, not three). Both premises are asserted, not assumed, so
    // a serializer change or a fixture edit fails loudly instead of quietly
    // turning this into a test of nothing.
    const actual = 'one two\n\nthreeX\n';
    expect(actual.length).toBe(primed.length);
    expect(actual).not.toBe(primed);

    // Prime: this call's `newBody` IS `primed`, so the memo ends up keyed on it.
    computeMapDrivenBodySplice('zzz\n', counted.parse(primed), counted, undefined, memo);

    const newPm = counted.parse('one two\n\nthreeY\n');
    const before = parses();
    const withMemo = computeMapDrivenBodySplice(actual, newPm, counted, undefined, memo);
    // TWO parses — both sides are new bytes. Measured against a length-based
    // comparison this reads ZERO, because `newBody` here is also 16 bytes and
    // so would "match" as well; that is the shape this test exists to reject.
    expect(parses() - before).toBe(2);

    // And the splice is anchored in `actual`'s block boundaries, not `primed`'s.
    const withoutMemo = computeMapDrivenBodySplice(actual, newPm, counted);
    expect(withMemo).toEqual(withoutMemo);
    expect(withMemo).not.toBeNull();
  });
});
