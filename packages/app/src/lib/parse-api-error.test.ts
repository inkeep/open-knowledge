import { describe, expect, test } from 'bun:test';
import { parseApiError } from './parse-api-error.ts';

describe('parseApiError', () => {
  test('null body → undefined', () => {
    expect(parseApiError(null)).toBeUndefined();
  });

  test('non-object primitive (string) → undefined', () => {
    expect(parseApiError('a string body')).toBeUndefined();
  });

  test('non-object primitive (number) → undefined', () => {
    expect(parseApiError(42)).toBeUndefined();
  });

  test('object without RFC 9457 title field → undefined', () => {
    expect(parseApiError({ status: 400, error: 'non-conforming field' })).toBeUndefined();
  });

  test('object with non-string title → undefined', () => {
    expect(parseApiError({ title: 42 })).toBeUndefined();
    expect(parseApiError({ title: null })).toBeUndefined();
  });

  test('object with empty-string title → undefined', () => {
    expect(parseApiError({ title: '' })).toBeUndefined();
  });

  test('RFC 9457 problem+json with non-empty title → returns title', () => {
    expect(
      parseApiError({
        type: 'urn:ok:error:invalid-request',
        title: 'Output path must be within home directory.',
        status: 400,
        instance: 'urn:uuid:00000000-0000-0000-0000-000000000000',
      }),
    ).toBe('Output path must be within home directory.');
  });

  test('RFC 9457 with extensions → still returns title', () => {
    expect(
      parseApiError({
        type: 'urn:ok:error:doc-already-exists',
        title: 'Exists.',
        status: 409,
        colliding: [{ existing: 'a', incoming: 'b' }],
      }),
    ).toBe('Exists.');
  });

  test('array input → undefined (typeof [] is "object" but no title)', () => {
    expect(parseApiError([])).toBeUndefined();
    expect(parseApiError(['some', 'array'])).toBeUndefined();
  });

  test('subclass-shaped object (Error instance) → undefined when no title', () => {
    expect(parseApiError(new Error('boom'))).toBeUndefined();
  });
});
