/**
 * Branch coverage for `parseApiError` — the shared client-side RFC 9457
 * problem+json parser. Indirect coverage exists in `skill-installer.test.ts`
 * (RFC 9457 happy paths + non-contract fallback), but the helper is the
 * canonical site for direct-HTTP consumers, so a focused unit test pins
 * each branch independently of any specific consumer.
 */

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
    // The helper only reads `title` per RFC 9457 §3.1.4; an `error`
    // field on the body (non-conforming shape — e.g. from a non-our-server
    // intermediary) is not consulted, so the caller falls back to the
    // HTTP status line.
    expect(parseApiError({ status: 400, error: 'non-conforming field' })).toBeUndefined();
  });

  test('object with non-string title → undefined', () => {
    // Defensive: a malformed body where `title` is wrongly typed must NOT
    // surface as the diagnostic — the shared parser treats it as missing.
    expect(parseApiError({ title: 42 })).toBeUndefined();
    expect(parseApiError({ title: null })).toBeUndefined();
  });

  test('object with empty-string title → undefined', () => {
    // RFC 9457 §3.1.4 requires title to be a non-empty short summary; an
    // empty string is structurally invalid, so the helper treats it as
    // missing and the caller falls back to the HTTP status line.
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
    // Extension members (RFC 9457 §3.2) don't change which field carries
    // the human-readable diagnostic.
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
    // `typeof [] === 'object'` so the null/typeof guard admits
    // arrays. The accessor `(arr as RfcProblemBody).title` is then `undefined`,
    // failing the string-presence check. Pin this so a future refactor that
    // tightens the guard (e.g., adds `Array.isArray` rejection) doesn't
    // accidentally start treating array entries as titles.
    expect(parseApiError([])).toBeUndefined();
    expect(parseApiError(['some', 'array'])).toBeUndefined();
  });

  test('subclass-shaped object (Error instance) → undefined when no title', () => {
    // Pino-serialized Errors land here when a caller misroutes them through
    // `parseApiError` instead of inspecting `cause`. The `Error` instance
    // has `message` / `stack` but no `title`, so the guard rejects.
    expect(parseApiError(new Error('boom'))).toBeUndefined();
  });
});
