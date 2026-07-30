/**
 * Anchor resolution against a repeated quote.
 *
 * The bug this pins: `indexOf` returns the FIRST match, so a phrase that appears
 * twice in a document highlighted and scrolled to the wrong occurrence. The
 * stored prefix/suffix have to break the tie.
 *
 * Exercises `findRangeInIndex` against a hand-built index rather than a real
 * ProseMirror doc — the disambiguation logic is what's under test, and the index
 * shape (`text` + per-character positions) is trivially constructible.
 */

import { describe, expect, test } from 'vitest';
import { findRangeInIndex } from './anchor-search';

/** Build the index `buildTextIndex` would produce, with PM positions offset by 1. */
function indexOf(text: string): { text: string; positions: number[] } {
  return { text, positions: Array.from({ length: text.length }, (_, i) => i + 1) };
}

const DOC = 'Add the garlic and cook 1 min. Stir the sauce. Add the garlic and serve.';
const FIRST = DOC.indexOf('Add the garlic');
const SECOND = DOC.indexOf('Add the garlic', FIRST + 1);

describe('findRangeInIndex — repeated quote', () => {
  test('the fixture really does repeat (guards the guard)', () => {
    expect(FIRST).toBeGreaterThanOrEqual(0);
    expect(SECOND).toBeGreaterThan(FIRST);
  });

  test('suffix context selects the SECOND occurrence', () => {
    const range = findRangeInIndex(indexOf(DOC), 'Add the garlic', {
      prefix: 'Stir the sauce. ',
      suffix: ' and serve.',
    });
    // positions are 1-based in the fixture, matching buildTextIndex's offset
    expect(range).toEqual({ from: SECOND + 1, to: SECOND + 1 + 'Add the garlic'.length });
  });

  test('prefix context selects the FIRST occurrence', () => {
    const range = findRangeInIndex(indexOf(DOC), 'Add the garlic', {
      prefix: '',
      suffix: ' and cook 1 min.',
    });
    expect(range).toEqual({ from: FIRST + 1, to: FIRST + 1 + 'Add the garlic'.length });
  });

  test('without context it falls back to the first match (the old behavior)', () => {
    const range = findRangeInIndex(indexOf(DOC), 'Add the garlic');
    expect(range?.from).toBe(FIRST + 1);
  });

  test('identical context on both hits falls back to the nearest position hint', () => {
    const doc = 'x TARGET y x TARGET y';
    const second = doc.indexOf('TARGET', doc.indexOf('TARGET') + 1);
    const range = findRangeInIndex(indexOf(doc), 'TARGET', {
      prefix: 'x ',
      suffix: ' y',
      start: second,
    });
    expect(range?.from).toBe(second + 1);
  });

  test('a quote that is gone resolves to null', () => {
    expect(findRangeInIndex(indexOf(DOC), 'text that is not there')).toBeNull();
  });

  test('a unique quote needs no context', () => {
    const range = findRangeInIndex(indexOf(DOC), 'Stir the sauce');
    expect(range?.from).toBe(DOC.indexOf('Stir the sauce') + 1);
  });
});

describe('findRangeInIndex — a markdown quote against rendered text', () => {
  // The stored quote is a slice of the markdown BODY, so a passage with any
  // formatting is not literally present in the editor's rendered text. Before
  // the elastic pass, every such comment silently failed to highlight or scroll.
  const RENDERED = 'Peanut sauce: 3 tbsp peanut butter, 2 tbsp soy sauce, water to loosen';

  test('locates a quote carrying emphasis markers the editor does not render', () => {
    const range = findRangeInIndex(indexOf(RENDERED), 'Peanut sauce:** 3 tbsp peanut butter');
    const start = RENDERED.indexOf('Peanut sauce: 3 tbsp peanut butter');
    expect(range).toEqual({
      from: start + 1,
      to: start + 1 + 'Peanut sauce: 3 tbsp peanut butter'.length,
    });
  });

  test('locates a quote carrying a list marker', () => {
    const range = findRangeInIndex(indexOf(RENDERED), '- **Peanut sauce:** 3 tbsp');
    expect(range?.from).toBe(1);
  });

  test('still returns null when the words are absent', () => {
    expect(findRangeInIndex(indexOf(RENDERED), '**Chili crisp:** 1 tbsp')).toBeNull();
  });
});

describe('findRangeInIndex — the passage was edited, not removed', () => {
  // The reported bug: comment on "needs space", edit it to "needs more space",
  // highlight vanishes. The server only re-finds on queue/dispatch, so the
  // document view has to recover the range itself.
  const DOC = 'Intro line. The layout needs space around the header. Outro line.';

  test('follows an insertion inside the passage', () => {
    const edited = DOC.replace('needs space', 'needs more space');
    const range = findRangeInIndex(indexOf(edited), 'needs space', {
      prefix: 'The layout ',
      suffix: ' around the header.',
    });
    const at = edited.indexOf('needs more space');
    expect(range).toEqual({ from: at + 1, to: at + 1 + 'needs more space'.length });
  });

  test('follows a deletion inside the passage', () => {
    const edited = DOC.replace('needs space around', 'needs space near');
    const range = findRangeInIndex(indexOf(edited), 'needs space around', {
      prefix: 'The layout ',
      suffix: ' the header.',
    });
    const at = edited.indexOf('needs space near');
    expect(range).toEqual({ from: at + 1, to: at + 1 + 'needs space near'.length });
  });

  test('an intact passage never reaches the bracket path', () => {
    const range = findRangeInIndex(indexOf(DOC), 'needs space', {
      prefix: 'The layout ',
      suffix: ' around the header.',
    });
    const at = DOC.indexOf('needs space');
    expect(range).toEqual({ from: at + 1, to: at + 1 + 'needs space'.length });
  });

  test('declines when the brackets are ambiguous', () => {
    const twice = 'A x B and later A y B';
    expect(findRangeInIndex(indexOf(twice), 'gone', { prefix: 'A ', suffix: ' B' })).toBeNull();
  });

  test('declines a wholesale replacement between the brackets', () => {
    const edited = DOC.replace('needs space', 'z'.repeat(400));
    expect(
      findRangeInIndex(indexOf(edited), 'needs space', {
        prefix: 'The layout ',
        suffix: ' around the header.',
      }),
    ).toBeNull();
  });

  test('declines when the passage was deleted outright', () => {
    const edited = DOC.replace('needs space ', '');
    expect(
      findRangeInIndex(indexOf(edited), 'needs space', {
        prefix: 'The layout ',
        suffix: 'around the header.',
      }),
    ).toBeNull();
  });
});
