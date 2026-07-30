/**
 * Markdown/rendered passage matching.
 *
 * The cases below are the ones that reached users as a bare 400 "the quoted
 * passage is not in the document": a comment on a bullet whose text starts
 * after a bold run, and a selection spanning a heading and the list under it.
 */

import { describe, expect, test } from 'vitest';
import { findAllPassages, findPassage } from './passage-match.ts';

const BODY = `## Ingredients

- 1½ cups shelled edamame (frozen, thawed)
- **Peanut sauce:** 3 tbsp peanut butter, 2 tbsp soy sauce, water to loosen
- Scallions, chopped peanuts, to serve

## Steps

1. Toss the tofu with the cornstarch and a pinch of salt.
2. Stir-fry the bell pepper 2–3 min, then add the edamame.
`;

/** The body slice a caller would store as the anchor's exact quote. */
function slice(needle: string, syntaxIn: 'haystack' | 'needle' = 'haystack'): string | null {
  const hit = findPassage(BODY, needle, { syntaxIn });
  return hit ? BODY.slice(hit.start, hit.end) : null;
}

describe('rendered text against a markdown body', () => {
  test('finds a passage that starts after a bold run inside a bullet', () => {
    // The reported failure: the source line is
    // `- **Peanut sauce:** 3 tbsp ...`, so neither the rendered text nor a
    // serialized partial selection is a literal substring of the body.
    expect(slice('3 tbsp peanut butter, 2 tbsp soy sauce')).toBe(
      '3 tbsp peanut butter, 2 tbsp soy sauce',
    );
  });

  test('spans the emphasis markers when the passage crosses them', () => {
    expect(slice('Peanut sauce: 3 tbsp peanut butter')).toBe(
      'Peanut sauce:** 3 tbsp peanut butter',
    );
  });

  test('skips the leading `**` rather than opening the range on it', () => {
    const hit = findPassage(BODY, 'Peanut sauce:', { syntaxIn: 'haystack' });
    expect(BODY.slice(hit?.start ?? 0, hit?.end ?? 0)).toBe('Peanut sauce:');
  });

  test('crosses a heading marker and an ordered-list marker', () => {
    expect(slice('Steps Toss the tofu with the cornstarch')).toBe(
      'Steps\n\n1. Toss the tofu with the cornstarch',
    );
  });

  test('crosses bullet markers between list items', () => {
    expect(slice('thawed) Peanut sauce:')).toBe('thawed)\n- **Peanut sauce:');
  });

  test('still refuses a passage that is not there', () => {
    expect(findPassage(BODY, 'gochujang to taste', { syntaxIn: 'haystack' })).toBeNull();
  });

  test('does not let syntax elasticity bridge different words', () => {
    // `peanut butter` and `soy sauce` both occur, but not adjacently — a fuzzy
    // matcher would happily join them.
    expect(findPassage(BODY, 'peanut soy', { syntaxIn: 'haystack' })).toBeNull();
  });

  test('an exact substring resolves to itself', () => {
    expect(slice('Scallions, chopped peanuts, to serve')).toBe(
      'Scallions, chopped peanuts, to serve',
    );
  });

  test('reports every occurrence in document order', () => {
    const hits = findAllPassages('a soy b soy', 'soy', { syntaxIn: 'haystack' });
    expect(hits.map((h) => h.start)).toEqual([2, 8]);
  });

  test('an empty needle matches nothing', () => {
    expect(findAllPassages(BODY, '', { syntaxIn: 'haystack' })).toEqual([]);
  });
});

describe('a markdown quote against rendered text', () => {
  // The mirror direction: a stored anchor is markdown, the editor's text index
  // is rendered, so the syntax now sits in the needle.
  const RENDERED = 'Peanut sauce: 3 tbsp peanut butter, 2 tbsp soy sauce, water to loosen';

  test('finds a bolded quote in rendered text', () => {
    const hit = findPassage(RENDERED, '**Peanut sauce:** 3 tbsp', { syntaxIn: 'needle' });
    expect(RENDERED.slice(hit?.start ?? -1, hit?.end ?? -1)).toBe('Peanut sauce: 3 tbsp');
  });

  test('finds a quote carrying a list marker it no longer renders', () => {
    const hit = findPassage(RENDERED, '- **Peanut sauce:** 3 tbsp', { syntaxIn: 'needle' });
    expect(hit?.start).toBe(0);
  });

  test('rejects a quote whose words are absent', () => {
    expect(findPassage(RENDERED, '**Chili crisp:**', { syntaxIn: 'needle' })).toBeNull();
  });
});

describe('links', () => {
  // A link renders as its label alone, so `](target)` is invisible to anyone
  // selecting rendered text. Missing that made every passage containing a link
  // unmatchable — which, in a linked wiki, is most of the interesting ones.
  const BODY =
    '- **Leftovers:** any half-finished tin goes into [Sardine Toast](../sardine/toast.md) or [[lemon-garlic]] the next day.';

  test('matches across an inline link', () => {
    const hit = findPassage(BODY, 'goes into Sardine Toast or', { syntaxIn: 'haystack' });
    expect(hit).not.toBeNull();
    expect(BODY.slice(hit?.start, hit?.end)).toContain('Sardine Toast');
  });

  test('matches across a wiki link', () => {
    expect(
      findPassage(BODY, 'or lemon-garlic the next day.', { syntaxIn: 'haystack' }),
    ).not.toBeNull();
  });

  test('matches a whole bullet containing two links', () => {
    const hit = findPassage(
      BODY,
      'Leftovers: any half-finished tin goes into Sardine Toast or lemon-garlic the next day.',
      { syntaxIn: 'haystack' },
    );
    expect(hit).not.toBeNull();
    // The resolved range covers the real source text, target and all.
    expect(BODY.slice(hit?.start, hit?.end)).toContain('../sardine/toast.md');
  });

  test('a match never begins on a bracket', () => {
    // Otherwise the reported range opens with syntax the caller never selected.
    const hit = findPassage(BODY, 'Sardine Toast', { syntaxIn: 'haystack' });
    expect(BODY[hit?.start ?? -1]).toBe('S');
  });

  test('the mirror direction: a stored markdown quote against rendered text', () => {
    const rendered = 'any half-finished tin goes into Sardine Toast or lemon-garlic the next day.';
    const stored = 'goes into [Sardine Toast](../sardine/toast.md) or [[lemon-garlic]]';
    expect(findPassage(rendered, stored, { syntaxIn: 'needle' })).not.toBeNull();
  });

  test('still refuses different words inside a link', () => {
    expect(findPassage(BODY, 'goes into Anchovy Toast or', { syntaxIn: 'haystack' })).toBeNull();
  });

  test('a bare bracket in prose is not treated as syntax', () => {
    const prose = 'the array[0] value is fine';
    expect(findPassage(prose, 'array[0] value', { syntaxIn: 'haystack' })).not.toBeNull();
  });
});
