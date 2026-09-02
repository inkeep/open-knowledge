import { describe, expect, test } from 'vitest';
import { extractComments, jsxModeForPath } from './extract.mjs';

const textsIn = (source, options) => extractComments(source, options).map((c) => c.text);

describe('extractComments finds comments and only comments', () => {
  test('a comment-shaped string literal is not a comment', () => {
    expect(textsIn('const s = "// keep"; // strip')).toEqual(['// strip']);
  });

  test('a single-quoted literal holding a block-comment opener is not a comment', () => {
    expect(textsIn("const s = '/* keep */'; // strip")).toEqual(['// strip']);
  });

  test('slashes inside a regex literal are not a comment', () => {
    expect(textsIn('const r = /a\\/\\/b/g; // strip')).toEqual(['// strip']);
  });

  test('a character class holding slashes is not a comment', () => {
    expect(textsIn('const r = /[/*]/; // strip')).toEqual(['// strip']);
  });

  test('division followed by a comment containing a slash keeps the comment', () => {
    expect(textsIn('const q = (a) / 2; // ratio a / 2')).toEqual(['// ratio a / 2']);
  });

  test('a comment inside a template-literal expression hole is a comment', () => {
    expect(textsIn('const t = `x ${ 1 /* inner */ } y`; // outer')).toEqual([
      '/* inner */',
      '// outer',
    ]);
  });

  test('comment syntax inside template-literal text is not a comment', () => {
    expect(textsIn('const t = `a // b /* c */`; // outer')).toEqual(['// outer']);
  });

  test('a nested template inside an expression hole stays balanced', () => {
    expect(textsIn('const t = `a ${ `b ${ 1 }` } c`; // outer')).toEqual(['// outer']);
  });

  test('a shebang line is not a comment', () => {
    expect(textsIn('#!/usr/bin/env node\n// real\n')).toEqual(['// real']);
  });

  test('an unterminated block comment runs to end of file', () => {
    expect(textsIn('const a = 1;\n/* never closed\nmore text')).toEqual([
      '/* never closed\nmore text',
    ]);
  });

  test('a line comment at end of file without a trailing newline is captured', () => {
    expect(textsIn('const a = 1; // last')).toEqual(['// last']);
  });

  test('an escaped quote does not end a string early', () => {
    expect(textsIn('const s = "a\\" // not"; // yes')).toEqual(['// yes']);
  });
});

describe('extractComments in JSX', () => {
  const tsx = { jsx: true };

  test('comment syntax in JSX text is content, not a comment', () => {
    expect(textsIn('const el = <div>a // b</div>;', tsx)).toEqual([]);
  });

  test('a JSX expression-container comment is a comment', () => {
    expect(textsIn('const el = <div>{/* real */}</div>;', tsx)).toEqual(['/* real */']);
  });

  test('comment syntax inside a JSX attribute string is content', () => {
    expect(textsIn('const el = <div title="a // b" />;', tsx)).toEqual([]);
  });

  test('a comment inside a JSX opening tag is a comment', () => {
    expect(textsIn('const el = <div /* here */ id="x" />;', tsx)).toEqual(['/* here */']);
  });

  test('a generic function type is not read as a JSX element', () => {
    const source = 'interface A {\n  run: <T>(x: T) => T;\n}\n// after';
    expect(textsIn(source, tsx)).toEqual(['// after']);
  });

  test('a generic arrow with a trailing comma is not read as a JSX element', () => {
    expect(textsIn('const id = <T,>(x: T) => x;\n// after', tsx)).toEqual(['// after']);
  });

  test('nested elements and fragments close correctly', () => {
    const source = 'const el = <><div><span>a // b</span></div></>;\n// after';
    expect(textsIn(source, tsx)).toEqual(['// after']);
  });

  test('a less-than comparison is not read as a JSX element', () => {
    expect(textsIn('const ok = a < b && c > d;\n// after', tsx)).toEqual(['// after']);
  });
});

describe('comment token metadata', () => {
  test('line and column are 1-based', () => {
    const [comment] = extractComments('const a = 1;\nconst b = 2; // note');
    expect({ line: comment.line, column: comment.column }).toEqual({ line: 2, column: 14 });
  });

  test('precededByCode distinguishes trailing from standalone comments', () => {
    const [trailing, standalone] = extractComments('const a = 1; // trailing\n// standalone');
    expect(trailing.precededByCode).toBe(true);
    expect(standalone.precededByCode).toBe(false);
  });

  test('kind separates line from block comments', () => {
    expect(extractComments('/* b */ // l').map((c) => c.kind)).toEqual(['block', 'line']);
  });
});

describe('jsxModeForPath', () => {
  test('only .tsx and .jsx sources are scanned in JSX mode', () => {
    expect(['a.tsx', 'a.jsx', 'a.ts', 'a.mjs'].map(jsxModeForPath)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});
