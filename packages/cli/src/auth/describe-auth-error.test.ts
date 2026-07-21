import { describe, expect, test } from 'vitest';
import { describeAuthFailure } from './describe-auth-error.ts';

describe('describeAuthFailure', () => {
  test('a self-signed / untrusted TLS cert is reported as a cert problem, not a bad token', () => {
    // undici surfaces TLS failures via err.cause.code
    const err = { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } };
    const failure = describeAuthFailure(err, 'ghes.acme.test');
    expect(failure.kind).toBe('tls');
    expect(failure.message).toContain('TLS certificate');
    expect(failure.message).toContain('ghes.acme.test');
    expect(failure.message).not.toContain('Token invalid');
  });

  test('other CERT_* codes are also classified as TLS', () => {
    for (const code of ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN']) {
      expect(describeAuthFailure({ cause: { code } }, 'h').kind).toBe('tls');
    }
  });

  test('a genuine 401 is reported as an invalid token', () => {
    const failure = describeAuthFailure({ status: 401 }, 'github.com');
    expect(failure.kind).toBe('token');
    expect(failure.message).toBe('Token invalid for github.com');
  });

  test('a 403 is reported as a scope/SSO problem, not an invalid token', () => {
    const failure = describeAuthFailure({ status: 403 }, 'ghes.acme.test');
    expect(failure.kind).toBe('token');
    expect(failure.message).toContain('scopes');
    expect(failure.message).toContain('SSO');
    expect(failure.message).not.toContain('invalid');
  });

  test('a non-cert network error names the code instead of blaming the token', () => {
    const failure = describeAuthFailure({ cause: { code: 'ECONNREFUSED' } }, 'ghes.acme.test');
    expect(failure.kind).toBe('network');
    expect(failure.message).toContain('ECONNREFUSED');
    expect(failure.message).not.toContain('Token invalid');
  });

  test('an unclassifiable error falls back to invalid-token (fail-safe default)', () => {
    expect(describeAuthFailure(new Error('boom'), 'h').kind).toBe('token');
    expect(describeAuthFailure(undefined, 'h').kind).toBe('token');
  });
});
