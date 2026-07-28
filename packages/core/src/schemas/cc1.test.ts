import { describe, expect, test } from 'vitest';
import { CC1_CONTRACT_VERSION } from '../constants/cc1.ts';
import {
  CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
  CC1ConfigIgnoreNestedErrorPayloadSchema,
} from './cc1.ts';

describe('CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR', () => {
  test('exposes the wire-level channel name', () => {
    expect(CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR).toBe('config-ignore-nested-error');
  });
});

describe('CC1ConfigIgnoreNestedErrorPayloadSchema', () => {
  test('parses a well-formed payload', () => {
    const payload = CC1ConfigIgnoreNestedErrorPayloadSchema.parse({
      v: CC1_CONTRACT_VERSION,
      ch: CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
      seq: 7,
      path: 'subdir/.okignore',
      error: 'unmatched bracket on line 3',
    });
    expect(payload.path).toBe('subdir/.okignore');
    expect(payload.error).toBe('unmatched bracket on line 3');
    expect(payload.seq).toBe(7);
  });

  test('rejects empty path', () => {
    expect(
      CC1ConfigIgnoreNestedErrorPayloadSchema.safeParse({
        v: CC1_CONTRACT_VERSION,
        ch: CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
        seq: 1,
        path: '',
        error: 'something',
      }).success,
    ).toBe(false);
  });

  test('rejects empty error', () => {
    expect(
      CC1ConfigIgnoreNestedErrorPayloadSchema.safeParse({
        v: CC1_CONTRACT_VERSION,
        ch: CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
        seq: 1,
        path: 'a/.okignore',
        error: '',
      }).success,
    ).toBe(false);
  });

  test('rejects wrong channel literal', () => {
    expect(
      CC1ConfigIgnoreNestedErrorPayloadSchema.safeParse({
        v: CC1_CONTRACT_VERSION,
        ch: 'files',
        seq: 1,
        path: 'a/.okignore',
        error: 'x',
      }).success,
    ).toBe(false);
  });

  test('forward-compat: extra fields pass through (`.loose()`)', () => {
    const parsed = CC1ConfigIgnoreNestedErrorPayloadSchema.parse({
      v: CC1_CONTRACT_VERSION,
      ch: CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
      seq: 2,
      path: 'a/.okignore',
      error: 'oops',
      futureField: { nested: true },
    });
    expect(parsed.path).toBe('a/.okignore');
  });
});
