import { describe, expect, test } from 'vitest';
import {
  blankComments,
  collectBlocks,
  normalizeSelector,
  splitSelectorList,
} from './globals-css.test-helper';

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

describe('globals.css block scanning', () => {
  test('an at-rule nested inside a style rule keeps both preludes and their own declarations', () => {
    const blocks = collectBlocks(
      '.surface { color: red; @media (min-width: 40rem) { padding-bottom: 1px; } }',
    );
    expect(
      blocks.map((block) => block.prelude),
      'the leaf-only regex this scanner replaces (`/([^{}]+)\\{([^{}]*)\\}/g`) cannot see past one ' +
        'brace level, so it reads the whole outer prelude plus the nested at-rule as one selector ' +
        'string and never reports `.surface` at all. A guard built on that reading attributes a ' +
        'nested declaration to nothing and passes silently',
    ).toEqual(['@media (min-width: 40rem)', '.surface']);
    expect(
      blocks.find((block) => block.prelude === '@media (min-width: 40rem)')?.declarations,
    ).toContain('padding-bottom: 1px');
    expect(
      blocks.find((block) => block.prelude === '.surface')?.declarations,
      'a declaration written before the nested at-rule belongs to the outer rule, not to the ' +
        'at-rule that follows it',
    ).toContain('color: red');
  });

  test('a brace inside a quoted attribute selector does not open or close a block', () => {
    const blocks = collectBlocks('[data-state="}"] .child { padding-bottom: 2px; }');
    expect(
      blocks.map((block) => block.prelude),
      'the `}` lives inside a quoted attribute value, so it is a literal character rather than a ' +
        'block terminator. A scanner that counts it closes the rule early and loses every ' +
        'declaration after it',
    ).toEqual(['[data-state="}"] .child']);
    expect(blocks[0]?.declarations).toContain('padding-bottom: 2px');
  });

  test('a comma inside brackets or parentheses does not split the selector list', () => {
    expect(
      splitSelectorList('[data-keys="a,b"], :is(.one, .two) .child, .last'),
      'only top-level commas separate selectors. Splitting on a comma nested in an attribute ' +
        'value or a functional pseudo-class yields selector fragments that match nothing, so a ' +
        'set-equality guard built on them reports a phantom difference or, worse, silently agrees',
    ).toEqual(['[data-keys="a,b"]', ':is(.one, .two) .child', '.last']);
  });

  test('a selector split across lines normalizes to its single-space form', () => {
    expect(
      normalizeSelector('.outer\n   .inner'),
      'globals.css wraps long selectors, and the tables these are compared against are written on ' +
        'one line. Without this collapse the two spellings of one selector never compare equal',
    ).toBe('.outer .inner');
  });

  test('a brace inside a comment cannot forge a block, whether or not the caller pre-blanks', () => {
    const raw = '.surface { /* opens { here */ padding-bottom: 3px; }';
    expect(
      collectBlocks(raw).map((block) => block.prelude),
      'the scanner consumes comments itself rather than making every caller remember to, which is ' +
        'where CSS Syntax L3 puts it (section 4.3.1, "consume a token", begins by consuming ' +
        'comments). Without that the brace inside the comment opens a block, `.surface` never ' +
        'closes, and the scanner reports the comment text as a selector: against globals.css that ' +
        'read yields 319 blocks instead of 745 and 23 inset-bearing selectors instead of 7, 16 of ' +
        'them comment prose',
    ).toEqual(['.surface']);
    expect(
      collectBlocks(blankComments(raw)),
      'blanking overwrites a comment in place with whitespace rather than splicing it out, so ' +
        'the second pass finds no `/*` where the comment was and none newly joined across its ' +
        'seam, and the `/*` that survive inside strings are skipped by both passes alike. That ' +
        'is what makes it idempotent, and it is why a caller that pre-blanks gets ' +
        'byte-identical output to one that does not',
    ).toEqual(collectBlocks(raw));
  });
});
