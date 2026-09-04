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

  test('strips a leading agent name mention when supplied', () => {
    expect(deriveThreadTitle("Claude, what's 2+2?", 'Claude')).toBe("What's 2+2?");
    expect(deriveThreadTitle('@Claude please fix the parser', 'Claude')).toBe('Fix the parser');
    expect(deriveThreadTitle('Cursor — update the sidebar copy', 'Cursor')).toBe(
      'Update the sidebar copy',
    );
  });

  test('leaves the name in the middle of a sentence alone', () => {
    expect(deriveThreadTitle('Ask Claude to summarize the PR', 'Claude')).toBe(
      'Ask Claude to summarize the PR',
    );
  });

  test('leaves a subject-position mention alone — "Codex is failing" ≠ "@Codex"', () => {
    expect(deriveThreadTitle('Codex is failing to start', 'Codex')).toBe(
      'Codex is failing to start',
    );
    expect(deriveThreadTitle('Claude crashed on startup', 'Claude')).toBe(
      'Claude crashed on startup',
    );
    expect(deriveThreadTitle('Cursor should not reformat the file', 'Cursor')).toBe(
      'Cursor should not reformat the file',
    );
  });

  test('rescues a title that opens with punctuation (dash bullet, stray "??")', () => {
    expect(deriveThreadTitle('— refactor the parser')).toBe('Refactor the parser');
    expect(deriveThreadTitle('?? fix the parser')).toBe('Fix the parser');
    expect(deriveThreadTitle(': update the roadmap doc')).toBe('Update the roadmap doc');
  });

  test('leaves punctuation glued to the next token alone — .env / --verbose / .gitignore', () => {
    expect(deriveThreadTitle('.env is missing the API key')).toBe('.env is missing the API key');
    expect(deriveThreadTitle('--verbose flag broken on Windows')).toBe(
      '--verbose flag broken on Windows',
    );
    expect(deriveThreadTitle('.gitignore not respected in nested repos')).toBe(
      '.gitignore not respected in nested repos',
    );
  });

  test('leaves an agent name glued to a dotfile alone — Codex.md ≠ Codex', () => {
    expect(deriveThreadTitle('Codex.md needs a heading', 'Codex')).toBe('Codex.md needs a heading');
    expect(deriveThreadTitle('cursor.json is malformed', 'Cursor')).toBe(
      'cursor.json is malformed',
    );
    expect(deriveThreadTitle('Codex. Fix the parser.', 'Codex')).toBe('Fix the parser.');
  });

  test('leaves an `@`-mentioned dotfile alone — @Codex.md ≠ @Codex', () => {
    expect(deriveThreadTitle('@Codex.md needs a heading', 'Codex')).toBe(
      '@Codex.md needs a heading',
    );
    expect(deriveThreadTitle('@CLAUDE.md needs updating', 'Claude')).toBe(
      '@CLAUDE.md needs updating',
    );
    expect(deriveThreadTitle('@Claude, fix the parser', 'Claude')).toBe('Fix the parser');
    expect(deriveThreadTitle('@Claude fix the parser', 'Claude')).toBe('Fix the parser');
    expect(deriveThreadTitle('@Codex?? fix the parser', 'Codex')).toBe('Fix the parser');
    expect(deriveThreadTitle('@Codex| fix the parser', 'Codex')).toBe('Fix the parser');
    expect(deriveThreadTitle('@Codex• fix the parser', 'Codex')).toBe('Fix the parser');
  });

  test('bare-name arm accepts `?` / `|` / `•` delimiters — parity with LEADING_PUNCT_RE', () => {
    expect(deriveThreadTitle('Codex? fix the parser', 'Codex')).toBe('Fix the parser');
    expect(deriveThreadTitle('Codex | fix the parser', 'Codex')).toBe('Fix the parser');
    expect(deriveThreadTitle('Codex • fix the parser', 'Codex')).toBe('Fix the parser');
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
