import { describe, expect, test } from 'vitest';
import { classifyParseError } from './frontmatter-malformed-error.ts';

describe('classifyParseError — bounded-cardinality refusal class', () => {
  test('top-level non-mapping bucket', () => {
    expect(classifyParseError('top-level value is not a mapping')).toBe('non-mapping-top-level');
  });

  test('schema rejection at a path', () => {
    expect(classifyParseError('value at "metadata" failed schema: Invalid input')).toBe(
      'schema-rejection',
    );
    expect(classifyParseError('value at "" failed schema: Expected string')).toBe(
      'schema-rejection',
    );
  });

  test('schema rejection at root', () => {
    expect(classifyParseError('schema validation failed: Invalid input')).toBe('schema-rejection');
  });

  test('parse threw — bytes failed yaml@2 parse', () => {
    expect(classifyParseError('parse threw: Unexpected token')).toBe('yaml-parse-error');
  });

  test('toJS threw — pathological document', () => {
    expect(classifyParseError('toJS threw: circular reference')).toBe('yaml-parse-error');
  });

  test('yaml@2 free-form line/column message — unquoted-colon class (PRD-6781)', () => {
    expect(
      classifyParseError('Nested mappings are not allowed in compact mappings at line 2, column 7'),
    ).toBe('yaml-parse-error');
    expect(classifyParseError('Map keys must be unique at line 4, column 1')).toBe(
      'yaml-parse-error',
    );
  });

  test('unknown fallback for the sentinel string', () => {
    expect(classifyParseError('unknown YAML parse error')).toBe('unknown');
  });

  test('unknown fallback for the empty string', () => {
    expect(classifyParseError('')).toBe('unknown');
  });

  test('classification is a bounded-cardinality enum (no path/byte content leaks)', () => {
    const classes = new Set<string>();
    for (const sample of [
      'top-level value is not a mapping',
      'value at "metadata.version" failed schema: Invalid',
      'value at "a.b.c.d.e.f.g.h" failed schema: Invalid',
      'schema validation failed: Invalid',
      'parse threw: anything',
      'toJS threw: anything',
      'Nested mappings are not allowed in compact mappings at line 9999, column 9999',
      'unknown YAML parse error',
      '',
    ]) {
      classes.add(classifyParseError(sample));
    }
    expect(classes.size).toBeLessThanOrEqual(4);
    for (const c of classes) {
      expect([
        'yaml-parse-error',
        'non-mapping-top-level',
        'schema-rejection',
        'unknown',
      ]).toContain(c);
    }
  });
});
