import { describe, expect, test } from 'vitest';
import { COMMENT_STATES, commentStates, stripComments } from './strip-comments.test-helper.mjs';

describe('stripComments', () => {
  test('removes line comments and the lines they occupied', () => {
    const source = ['const a = 1;', '// a note', 'const b = 2;'].join('\n');
    expect(stripComments(source)).toBe(['const a = 1;', 'const b = 2;'].join('\n'));
  });

  test('removes block comments spanning many lines', () => {
    const source = ['/**', ' * prose', ' */', 'export const a = 1;'].join('\n');
    expect(stripComments(source)).toBe('export const a = 1;');
  });

  test('keeps the code that shared a line with a trailing comment', () => {
    expect(stripComments('const a = 1; // why')).toBe('const a = 1; ');
  });

  test('never fuses the tokens a comment separated', () => {
    expect(stripComments('a/**/b')).toBe('a b');
  });

  test('leaves comment syntax inside string literals alone', () => {
    const source = "const url = 'https://example.com'; const marker = '// not a comment';";
    expect(stripComments(source)).toBe(source);
  });

  test('leaves JSX text that looks like a comment alone', () => {
    const source = 'export const El = () => <p>50/100 // ratio</p>;';
    expect(stripComments(source, { path: 'El.tsx' })).toBe(source);
  });

  test('is a no-op on a source with no comments', () => {
    const source = 'export const a = 1;\nexport const b = 2;\n';
    expect(stripComments(source)).toBe(source);
  });

  test('strips a real in-repo source file down to comment-free code', () => {
    const source = [
      '/** header */',
      "import { readFileSync } from 'node:fs';",
      '',
      'export function read(path: string): string {',
      '  // read it',
      '  return readFileSync(path, /* encoding */ "utf-8");',
      '}',
    ].join('\n');
    const stripped = stripComments(source, { path: 'read.ts' });
    expect(stripped).not.toMatch(/\/\/|\/\*|\*\//);
    expect(stripped).toContain('readFileSync(path,  "utf-8")');
  });
});

describe('commentStates', () => {
  test('yields the authored source first and the stripped source second', () => {
    const source = 'const a = 1;\n// note\n';
    const states = commentStates(source);

    expect(states.map(([label]) => label)).toEqual(COMMENT_STATES);
    expect(states[0][1]).toBe(source);
    expect(states[1][1]).not.toBe(source);
    expect(states[1][1]).not.toContain('// note');
  });
});
