import { describe, expect, test } from 'vitest';
import { blankComments } from './globals-css.test-helper';

describe('globals.css comment stripping', () => {
  test('a `/*` inside a quoted at-rule argument does not open a comment', () => {
    const css = '@source "../node_modules/streamdown/dist/*.js";\n.target { padding: 0 }\n/* x */';
    expect(
      blankComments(css).includes('.target { padding: 0 }'),
      'the naive `replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")` opens a comment at the `/*` inside the ' +
        '@source string and closes it at the next real `*/`, deleting everything between. ' +
        'globals.css carries that exact at-rule, so a naive strip silently discards about half ' +
        'the stylesheet and every rule lookup against it goes vacuous instead of red',
    ).toBe(true);
  });

  test('real comments are blanked without moving any other byte', () => {
    const css = '.a { color: red } /* note */ .b { color: blue }';
    const blanked = blankComments(css);
    expect(blanked.length).toBe(css.length);
    expect(blanked.includes('note')).toBe(false);
    expect(blanked.startsWith('.a { color: red }')).toBe(true);
    expect(blanked.endsWith('.b { color: blue }')).toBe(true);
  });

  test('line numbers survive a multi-line comment', () => {
    const css = '.a {}\n/* one\n   two */\n.b {}';
    expect(blankComments(css).split('\n').length).toBe(css.split('\n').length);
  });
});
