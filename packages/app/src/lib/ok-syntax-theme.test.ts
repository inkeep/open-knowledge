/**
 * Runs the real Shiki against `okSyntaxTheme`. The theme's whole premise is
 * that a `var(...)` string survives tokenization as a token color instead of
 * being parsed as a color and rejected — assert it rather than trust it, since
 * a Shiki upgrade that started validating color syntax would otherwise fail
 * silently as unpainted code rather than as a thrown error.
 */

import langTsx from '@shikijs/langs/tsx';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { beforeAll, describe, expect, test } from 'vitest';
import { OK_SYNTAX_THEME_NAME, okSyntaxTheme } from './ok-syntax-theme';

let highlighter: Awaited<ReturnType<typeof createHighlighterCore>>;

beforeAll(async () => {
  highlighter = await createHighlighterCore({
    themes: [okSyntaxTheme],
    langs: [langTsx],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
});

/** Flattened tokens for one line of tsx, keyed by content. */
function colorOf(code: string, content: string): string | undefined {
  const { tokens } = highlighter.codeToTokens(code, {
    lang: 'tsx',
    theme: OK_SYNTAX_THEME_NAME,
  });
  return tokens.flat().find((token) => token.content.trim() === content)?.color;
}

describe('okSyntaxTheme', () => {
  test('loads under its registered name', () => {
    expect(highlighter.getLoadedThemes()).toContain(OK_SYNTAX_THEME_NAME);
  });

  test('paints tokens with the custom properties the CodeMirror theme uses', () => {
    const code = 'const answer = 42; // note\n';
    expect(colorOf(code, 'const')).toBe('var(--syntax-keyword)');
    expect(colorOf(code, '42')).toBe('var(--syntax-number)');
    expect(colorOf(code, '// note')).toBe('var(--syntax-comment)');
  });

  test('paints a string and its delimiters from the one string slot', () => {
    // The grammar emits the quotes as tokens of their own, and CodeMirror
    // paints them with the body — so they must not fall through to the
    // `punctuation` rule. Sharing the slot makes Shiki merge all three into a
    // single token, which is what this asserts: a `"hi"` token exists at all.
    expect(colorOf('const s = "hi";\n', '"hi"')).toBe('var(--syntax-string)');
  });

  test('resolves the editor foreground to an app token, not a baked color', () => {
    const { fg, bg } = highlighter.codeToTokens('x\n', {
      lang: 'tsx',
      theme: OK_SYNTAX_THEME_NAME,
    });
    expect(fg).toBe('var(--foreground)');
    expect(bg).toBe('var(--background)');
  });

  test('declares no chrome colors — only the editor foreground and background', () => {
    // The regression this guards. `gitDecoration.*` and `terminal.ansi*` look
    // like harmless metadata, but Pierre expands them into
    // `--diffs-addition-color` / `--diffs-modified-color` and writes them at
    // `:host`, where they outrank the `--diffs-*` block in globals.css and
    // silently take over the fill of both halves of every merge conflict.
    // Conflict fills are chrome and belong in the stylesheet; a color added
    // here would move them back out of reach.
    expect(Object.keys(okSyntaxTheme.colors ?? {})).toEqual([
      'editor.foreground',
      'editor.background',
    ]);
  });

  test('no token can pin a baked color', () => {
    const code = [
      'import type { Thing } from "./thing";',
      '// a comment',
      'export class Widget extends Thing {',
      '  render(count = 42, flag = true) {',
      '    return String(count) ?? /re/g;',
      '  }',
      '}',
      '',
    ].join('\n');
    const { tokens } = highlighter.codeToTokens(code, {
      lang: 'tsx',
      theme: OK_SYNTAX_THEME_NAME,
    });
    const colors = tokens.flat().map((token) => token.color);
    expect(colors.length).toBeGreaterThan(30);
    for (const color of colors) {
      expect(color).toMatch(/^var\(--[a-z0-9-]+\)$/);
    }
  });
});
