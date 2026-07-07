import { describe, expect, test } from 'bun:test';
import { CODE_BLOCK_LANGUAGES, normalizeCodeLanguage } from './code-block-languages';

describe('normalizeCodeLanguage', () => {
  test('null / undefined / empty → null', () => {
    expect(normalizeCodeLanguage(null)).toBeNull();
    expect(normalizeCodeLanguage(undefined)).toBeNull();
    expect(normalizeCodeLanguage('')).toBeNull();
  });

  test('canonical value passes through', () => {
    expect(normalizeCodeLanguage('javascript')).toBe('javascript');
    expect(normalizeCodeLanguage('python')).toBe('python');
    expect(normalizeCodeLanguage('rust')).toBe('rust');
    expect(normalizeCodeLanguage('xml')).toBe('xml');
  });

  test('common aliases resolve', () => {
    expect(normalizeCodeLanguage('js')).toBe('javascript');
    expect(normalizeCodeLanguage('jsx')).toBe('javascript');
    expect(normalizeCodeLanguage('mjs')).toBe('javascript');
    expect(normalizeCodeLanguage('cjs')).toBe('javascript');
    expect(normalizeCodeLanguage('ts')).toBe('typescript');
    expect(normalizeCodeLanguage('tsx')).toBe('typescript');
    expect(normalizeCodeLanguage('py')).toBe('python');
    expect(normalizeCodeLanguage('rs')).toBe('rust');
    expect(normalizeCodeLanguage('sh')).toBe('bash');
    expect(normalizeCodeLanguage('zsh')).toBe('bash');
    expect(normalizeCodeLanguage('html')).toBe('xml');
    expect(normalizeCodeLanguage('htm')).toBe('xml');
    expect(normalizeCodeLanguage('svg')).toBe('xml');
    expect(normalizeCodeLanguage('yml')).toBe('yaml');
    expect(normalizeCodeLanguage('md')).toBe('markdown');
    expect(normalizeCodeLanguage('mdx')).toBe('markdown');
  });

  test('case-insensitive — uppercase aliases resolve', () => {
    expect(normalizeCodeLanguage('JS')).toBe('javascript');
    expect(normalizeCodeLanguage('TypeScript')).toBe('typescript');
    expect(normalizeCodeLanguage('HTML')).toBe('xml');
  });

  test('unknown language → lowercase passthrough (degrade gracefully)', () => {
    expect(normalizeCodeLanguage('zig')).toBe('zig');
    expect(normalizeCodeLanguage('NIM')).toBe('nim');
    expect(normalizeCodeLanguage('elixir')).toBe('elixir');
  });

  test('`shell` resolves to canonical `shell` (NOT `bash`)', () => {
    // Guard against the dead-alias regression — `'shell'` is its own
    // highlight.js grammar (shell-session prompt + output) distinct from
    // `bash`. Earlier revisions listed `'shell'` as a bash alias; the
    // ALIAS_MAP silently overwrote it with the canonical, making the alias
    // dead but masking the configuration error. This test pins the intended
    // behavior so reverting the alias breaks the suite, not the UI.
    expect(normalizeCodeLanguage('shell')).toBe('shell');
    expect(normalizeCodeLanguage('console')).toBe('shell');
    expect(normalizeCodeLanguage('shellsession')).toBe('shell');
  });
});

describe('CODE_BLOCK_LANGUAGES table invariants', () => {
  test('every value is unique', () => {
    const values = CODE_BLOCK_LANGUAGES.map((l) => l.value);
    expect(new Set(values).size).toBe(values.length);
  });

  test('no alias collides with another entry`s canonical value', () => {
    const canonicals = new Set(CODE_BLOCK_LANGUAGES.map((l) => l.value));
    for (const lang of CODE_BLOCK_LANGUAGES) {
      for (const alias of lang.aliases ?? []) {
        // An alias of language X equal to canonical Y's value would be a
        // silent override (last-write-wins in ALIAS_MAP). Catch both
        // directions: alias===other-canonical and canonical===alias-of-other.
        if (alias === lang.value) continue; // self-alias is a no-op, fine
        if (canonicals.has(alias)) {
          throw new Error(
            `Alias collision: "${alias}" listed as alias of "${lang.value}" but is canonical for another entry`,
          );
        }
      }
    }
  });

  test('no duplicate aliases across entries', () => {
    const seen = new Map<string, string>();
    for (const lang of CODE_BLOCK_LANGUAGES) {
      for (const alias of lang.aliases ?? []) {
        const prior = seen.get(alias);
        if (prior && prior !== lang.value) {
          throw new Error(`Alias "${alias}" listed under both "${prior}" and "${lang.value}"`);
        }
        seen.set(alias, lang.value);
      }
    }
  });

  test('first entry is plaintext (the canonical "no highlighting" option)', () => {
    expect(CODE_BLOCK_LANGUAGES[0]?.value).toBe('plaintext');
  });
});
