import { describe, expect, test } from 'vitest';
import { clampThreadTitle, deriveThreadTitle, TITLE_MAX_CHARS } from './thread-title.ts';

describe('deriveThreadTitle', () => {
  test('passes a plain imperative line through unchanged', () => {
    expect(deriveThreadTitle('Fix the login bug')).toBe('Fix the login bug');
  });

  test('strips a single filler prefix and recapitalizes', () => {
    expect(deriveThreadTitle('please update the roadmap doc')).toBe('Update the roadmap doc');
    expect(deriveThreadTitle('can you add tests for the parser')).toBe('Add tests for the parser');
  });

  test('strips stacked filler ("hey, can you please take a look at …")', () => {
    expect(deriveThreadTitle('hey, can you please take a look at the pricing page copy')).toBe(
      'The pricing page copy',
    );
  });

  test('keeps the raw line when stripping leaves a stub', () => {
    // "there" alone is not a title — greeting-ish prompts degrade gracefully.
    expect(deriveThreadTitle('hello there')).toBe('hello there');
    expect(deriveThreadTitle('hey can you')).toBe('hey can you');
  });

  test('adopts a two-word remainder', () => {
    expect(deriveThreadTitle('please fix bug')).toBe('Fix bug');
  });

  test('does not strip bare aux verbs that carry meaning', () => {
    expect(deriveThreadTitle('Will this break the release build?')).toBe(
      'Will this break the release build?',
    );
  });

  test('drops markdown lead-in', () => {
    expect(deriveThreadTitle('## Update the changelog')).toBe('Update the changelog');
    expect(deriveThreadTitle('- please rename the folder structure')).toBe(
      'Rename the folder structure',
    );
  });

  test('uses only the first non-empty line', () => {
    expect(deriveThreadTitle('\n\nplease review this diff\nwith lots of context below')).toBe(
      'Review this diff',
    );
  });

  test('non-English prompts pass through untouched', () => {
    expect(deriveThreadTitle('actualiza la hoja de ruta por favor')).toBe(
      'actualiza la hoja de ruta por favor',
    );
  });

  test('clamps long results at a word boundary with an ellipsis', () => {
    const derived = deriveThreadTitle(
      'please update the roadmap document with the newly agreed quarterly milestones',
    );
    expect(derived.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(derived.endsWith('…')).toBe(true);
    expect(derived).toBe('Update the roadmap document with the newly…');
  });
});

describe('clampThreadTitle', () => {
  test('returns blank input as empty string', () => {
    expect(clampThreadTitle('')).toBe('');
    expect(clampThreadTitle('   \n  ')).toBe('');
  });

  test('keeps short titles verbatim — no stripping, no recapitalization', () => {
    expect(clampThreadTitle('please my weird title')).toBe('please my weird title');
  });

  test('takes the first line of multi-line input', () => {
    expect(clampThreadTitle('first line\nsecond line')).toBe('first line');
  });

  test('hard-cuts a single long word when no word boundary is usable', () => {
    const word = 'x'.repeat(80);
    const clamped = clampThreadTitle(word);
    expect(clamped.length).toBe(TITLE_MAX_CHARS);
    expect(clamped.endsWith('…')).toBe(true);
  });
});
