import { describe, expect, test } from 'vitest';
import { parseAttributeLiteral } from './mdx-attribute-literal.ts';

describe('parseAttributeLiteral', () => {
  test('reads the single-quoted string arrays MDX attributes are written with', () => {
    expect(parseAttributeLiteral("['Desktop app', 'Web app']")).toEqual(['Desktop app', 'Web app']);
  });

  test('reads an object with unquoted keys, quoted keys, and a trailing comma', () => {
    expect(
      parseAttributeLiteral(`{
        "src": { description: 'Image source', required: true, },
        alt: { required: false },
      }`),
    ).toEqual({
      src: { description: 'Image source', required: true },
      alt: { required: false },
    });
  });

  test('reads a multi-line template literal, which is how diagram sources arrive', () => {
    expect(parseAttributeLiteral('`graph LR\n  A --> B`')).toBe('graph LR\n  A --> B');
  });

  test('applies string escapes rather than passing the backslash through', () => {
    expect(parseAttributeLiteral(String.raw`"a\\b \"c\" é \n"`)).toBe('a\\b "c" é \n');
  });

  test('reads numbers, booleans, null, and undefined', () => {
    expect(parseAttributeLiteral('[1, -2.5, 3e2, true, false, null, undefined]')).toEqual([
      1,
      -2.5,
      300,
      true,
      false,
      null,
      undefined,
    ]);
  });

  test('skips comments, which authors leave inside prop objects', () => {
    expect(parseAttributeLiteral('{ /* note */ a: 1, // trailing\n b: 2 }')).toEqual({
      a: 1,
      b: 2,
    });
  });
});

describe('anything that is not a literal', () => {
  test('a free identifier is refused by name', () => {
    expect(() => parseAttributeLiteral('{ items: SUPPORTED_EDITORS }')).toThrow(
      'identifier "SUPPORTED_EDITORS" is not a literal',
    );
  });

  test('a function call is refused', () => {
    expect(() => parseAttributeLiteral('buildRows()')).toThrow('is not a literal');
  });

  test('a template interpolation is refused instead of being emitted verbatim', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the input under test
    expect(() => parseAttributeLiteral('`count: ${total}`')).toThrow(
      'template interpolation is not a literal',
    );
  });

  test('trailing input after a complete literal is refused', () => {
    expect(() => parseAttributeLiteral("['a'] ?? []")).toThrow('unexpected trailing input');
  });

  test('a malformed hex escape is refused, never coerced to NUL', () => {
    expect(() => parseAttributeLiteral("['a\\uZZZZb']")).toThrow('malformed escape');
    expect(() => parseAttributeLiteral("['a\\xZZb']")).toThrow('malformed escape');
    expect(() => parseAttributeLiteral("['\\u{WXYZ}']")).toThrow('malformed escape');
  });

  test('a braced escape beyond the Unicode range is refused with a position', () => {
    expect(() => parseAttributeLiteral("['\\u{110000}']")).toThrow('beyond the Unicode range');
  });

  test('the failure names the line, so a multi-line prop object is locatable', () => {
    expect(() => parseAttributeLiteral('{\n  a: 1,\n  b: someVar,\n}')).toThrow('at line 3');
  });
});
