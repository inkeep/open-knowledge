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

  test('strips a leading agent name mention when supplied', () => {
    // Every tab already shows the agent icon; leaving "Claude, …" as the
    // distinguishing lead wastes half the label's width.
    expect(deriveThreadTitle("Claude, what's 2+2?", 'Claude')).toBe("What's 2+2?");
    expect(deriveThreadTitle('@Claude please fix the parser', 'Claude')).toBe('Fix the parser');
    expect(deriveThreadTitle('Cursor — update the sidebar copy', 'Cursor')).toBe(
      'Update the sidebar copy',
    );
  });

  test('leaves the name in the middle of a sentence alone', () => {
    // Only a LEADING mention is dead weight; "Ask Claude to do X" is real content.
    expect(deriveThreadTitle('Ask Claude to summarize the PR', 'Claude')).toBe(
      'Ask Claude to summarize the PR',
    );
  });

  test('leaves a subject-position mention alone — "Codex is failing" ≠ "@Codex"', () => {
    // Bare whitespace after the name is not addressing punctuation; the strip
    // fires only for `@Codex …`, `Codex, …`, `Codex — …`. Otherwise a bug
    // report titled after the agent would be mangled into a broken predicate.
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
    // FILLER_RE already trims its own trailing separator, so this pass only
    // triggers when the input itself opens with punctuation — an em-dash
    // bullet, a leftover `??`, a stray colon after a quote strip.
    expect(deriveThreadTitle('— refactor the parser')).toBe('Refactor the parser');
    expect(deriveThreadTitle('?? fix the parser')).toBe('Fix the parser');
    expect(deriveThreadTitle(': update the roadmap doc')).toBe('Update the roadmap doc');
  });

  test('leaves punctuation glued to the next token alone — .env / --verbose / .gitignore', () => {
    // Coding-agent prompts open with these constantly. If the punctuation
    // strip fired without requiring whitespace after, `.env is missing …`
    // would mangle to `Env is missing …` — same defect class as the
    // bare-space agent-name bug.
    expect(deriveThreadTitle('.env is missing the API key')).toBe('.env is missing the API key');
    expect(deriveThreadTitle('--verbose flag broken on Windows')).toBe(
      '--verbose flag broken on Windows',
    );
    expect(deriveThreadTitle('.gitignore not respected in nested repos')).toBe(
      '.gitignore not respected in nested repos',
    );
  });

  test('leaves an agent name glued to a dotfile alone — Codex.md ≠ Codex', () => {
    // Address form requires a whitespace/EOS delimiter after the punctuation
    // so `Codex.md needs a heading` doesn't strip to `Md needs a heading`.
    expect(deriveThreadTitle('Codex.md needs a heading', 'Codex')).toBe('Codex.md needs a heading');
    expect(deriveThreadTitle('cursor.json is malformed', 'Cursor')).toBe(
      'cursor.json is malformed',
    );
    // A period followed by a space IS an address form ("Codex. Fix …").
    expect(deriveThreadTitle('Codex. Fix the parser.', 'Codex')).toBe('Fix the parser.');
  });

  test('leaves an `@`-mentioned dotfile alone — @Codex.md ≠ @Codex', () => {
    // The @-mention arm needs the same whitespace-or-EOS delimiter as the
    // bare-name arm; otherwise `@CLAUDE.md needs updating` (an @-mention
    // of the file, not the agent) mangles to `Md needs updating`.
    expect(deriveThreadTitle('@Codex.md needs a heading', 'Codex')).toBe(
      '@Codex.md needs a heading',
    );
    expect(deriveThreadTitle('@CLAUDE.md needs updating', 'Claude')).toBe(
      '@CLAUDE.md needs updating',
    );
    // A real @-mention address still strips.
    expect(deriveThreadTitle('@Claude, fix the parser', 'Claude')).toBe('Fix the parser');
    expect(deriveThreadTitle('@Claude fix the parser', 'Claude')).toBe('Fix the parser');
    // An @-mention with a non-alpha delimiter (`?` / `•` / `|`) is still
    // an address — the delimiter class matches LEADING_PUNCT_RE parity.
    // Both arms share one interpolated `delim` constant (thread-title.ts),
    // so pinning each char through EITHER arm now guards the shared class;
    // exercising the @-arm alongside the bare-name block is belt-and-
    // suspenders in case future changes give the arms independent classes
    // again.
    expect(deriveThreadTitle('@Codex?? fix the parser', 'Codex')).toBe('Fix the parser');
    expect(deriveThreadTitle('@Codex| fix the parser', 'Codex')).toBe('Fix the parser');
    expect(deriveThreadTitle('@Codex• fix the parser', 'Codex')).toBe('Fix the parser');
  });

  test('bare-name arm accepts `?` / `|` / `•` delimiters — parity with LEADING_PUNCT_RE', () => {
    // The bare-name (unprefixed) delimiter class matches LEADING_PUNCT_RE's,
    // so every non-alpha punctuation char that would clean an opening title
    // also counts as an addressing delimiter after the name. Each of these
    // characters is a distinct code point — the test pins them individually
    // so a copy-paste that lands a lookalike (or drops one from the class)
    // reddens.
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
