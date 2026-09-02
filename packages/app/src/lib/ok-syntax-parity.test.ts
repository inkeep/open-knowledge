import { javascript } from '@codemirror/lang-javascript';
import { highlightTree } from '@lezer/highlight';
import langTsx from '@shikijs/langs/tsx';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { beforeAll, describe, expect, test } from 'vitest';
import { okSyntaxHighlight } from '@/editor/extensions/cm-theme';
import { OK_SYNTAX_THEME_NAME, okSyntaxTheme } from './ok-syntax-theme';

function slotOf(color: string | undefined): string | null {
  const match = color?.match(/^var\(--([a-z0-9-]+)\)$/);
  return match ? match[1] : null;
}

function cmClassToSlot(): Map<string, string> {
  const rules = okSyntaxHighlight.module?.getRules() ?? '';
  const map = new Map<string, string>();
  for (const rule of rules.matchAll(/\.(\S+?)\s*\{([^}]*)\}/g)) {
    const slot = slotOf(rule[2].match(/color:\s*(var\([^)]*\))/)?.[1]);
    if (slot) map.set(rule[1], slot);
  }
  return map;
}

function cmSlots(source: string): Array<string | null> {
  const classToSlot = cmClassToSlot();
  const tree = javascript({ jsx: true, typescript: true }).language.parser.parse(source);
  const out: Array<string | null> = new Array(source.length).fill(null);
  highlightTree(tree, okSyntaxHighlight, (from, to, classes) => {
    for (const cls of classes.split(' ')) {
      const slot = classToSlot.get(cls);
      if (!slot) continue;
      for (let i = from; i < to; i += 1) out[i] = slot;
    }
  });
  return out;
}

let highlighter: Awaited<ReturnType<typeof createHighlighterCore>>;

beforeAll(async () => {
  highlighter = await createHighlighterCore({
    themes: [okSyntaxTheme],
    langs: [langTsx],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
});

function compare(source: string): Array<{ text: string; shiki: string | null; cm: string | null }> {
  const cm = cmSlots(source);
  const { tokens } = highlighter.codeToTokens(source, {
    lang: 'tsx',
    theme: OK_SYNTAX_THEME_NAME,
  });
  const rows: Array<{ text: string; shiki: string | null; cm: string | null }> = [];
  for (const line of tokens) {
    for (const token of line) {
      if (token.content.trim() === '') continue;
      let cmSlot: string | null = null;
      for (let i = token.offset; i < token.offset + token.content.length; i += 1) {
        if (cm[i]) {
          cmSlot = cm[i];
          break;
        }
      }
      rows.push({ text: token.content, shiki: slotOf(token.color), cm: cmSlot });
    }
  }
  return rows;
}

function disagreements(source: string) {
  return compare(source).filter((row) => row.shiki && row.cm && row.shiki !== row.cm);
}

describe('CodeMirror ↔ Shiki slot parity', () => {
  test('keywords, strings, numbers and comments agree', () => {
    const source = [
      '// a comment',
      'const total = 42;',
      'let name = "Ada";',
      'if (total > 0) return null;',
      '',
    ].join('\n');
    expect(disagreements(source)).toEqual([]);
  });

  test('functions, types and class names agree', () => {
    const source = [
      'class Widget extends Thing {',
      '  render(count) {',
      '    return format(count);',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(disagreements(source)).toEqual([]);
  });

  test('both engines actually styled the sample', () => {
    const rows = compare('const total = 42; // note\n');
    expect(rows.filter((row) => row.shiki !== null).length).toBeGreaterThan(3);
    expect(rows.filter((row) => row.cm !== null).length).toBeGreaterThan(3);
  });

  test('a broad sample diverges only where the two parsers genuinely disagree', () => {
    const source = [
      'import { readFile } from "node:fs";',
      'export const LIMIT = 100;',
      'type Shape = { kind: string; size: number };',
      'const fn = (a, b) => a ?? b;',
      'const re = /ab+c/gi;',
      'const obj = { key: "value", nested: { flag: true, missing: null } };',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source that must contain a real template literal for both engines to tokenize
      'function greet(name = "world") { return `hi ${name}`; }',
      'class A { static x = 1; get y() { return 2; } }',
      'for (let i = 0; i < 10; i++) { obj.key = String(i); }',
      'try { greet(); } catch (err) { console.error(err); }',
      '',
    ].join('\n');

    expect(disagreements(source)).toEqual([
      { text: 'error', shiki: 'syntax-func', cm: 'syntax-attr' },
    ]);
  });
});
