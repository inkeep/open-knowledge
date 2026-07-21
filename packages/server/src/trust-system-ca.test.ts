import tls from 'node:tls';
import { describe, expect, test } from 'vitest';
import {
  _resetTrustSystemCertificatesForTest,
  trustSystemCertificates,
} from './trust-system-ca.ts';

describe('trustSystemCertificates', () => {
  test('never throws (feature-detected; no-ops on older Node)', () => {
    _resetTrustSystemCertificatesForTest();
    expect(() => trustSystemCertificates()).not.toThrow();
  });

  test('is idempotent — a second call is a no-op', () => {
    _resetTrustSystemCertificatesForTest();
    let sets = 0;
    const api = tls as unknown as { setDefaultCACertificates?: unknown };
    const original = api.setDefaultCACertificates;
    if (typeof original !== 'function') return; // older Node — nothing to assert
    api.setDefaultCACertificates = () => {
      sets += 1;
    };
    try {
      trustSystemCertificates();
      trustSystemCertificates();
      expect(sets).toBe(1);
    } finally {
      api.setDefaultCACertificates = original;
    }
  });

  test('a failed apply stays retryable — the next call tries again and can succeed', () => {
    _resetTrustSystemCertificatesForTest();
    const api = tls as unknown as { setDefaultCACertificates?: (c: readonly string[]) => void };
    const original = api.setDefaultCACertificates;
    if (typeof original !== 'function') return; // older Node — nothing to assert
    let calls = 0;
    api.setDefaultCACertificates = () => {
      calls += 1;
      // e.g. a locked Keychain at cold start — transient, not permanent.
      if (calls === 1) throw new Error('keychain locked');
    };
    try {
      trustSystemCertificates(); // fails, must not latch the guard
      trustSystemCertificates(); // retries and succeeds, latches
      trustSystemCertificates(); // idempotent after success
      expect(calls).toBe(2);
    } finally {
      api.setDefaultCACertificates = original;
      _resetTrustSystemCertificatesForTest();
    }
  });

  test('on a runtime with the CA APIs, it installs a superset of the default bundle', () => {
    _resetTrustSystemCertificatesForTest();
    const api = tls as unknown as {
      getCACertificates?: (type?: string) => string[];
      setDefaultCACertificates?: (c: readonly string[]) => void;
    };
    if (
      typeof api.getCACertificates !== 'function' ||
      typeof api.setDefaultCACertificates !== 'function'
    ) {
      return; // older Node — nothing to assert
    }
    const bundledCount = api.getCACertificates('default').length;
    trustSystemCertificates();
    expect(api.getCACertificates('default').length).toBeGreaterThanOrEqual(bundledCount);
  });
});
