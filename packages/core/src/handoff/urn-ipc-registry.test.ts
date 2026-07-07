/**
 * Behavioral coverage for `lookupUrnInRegistry` — pins the four return
 * shapes against the registry contract.
 *
 * The colocated `urn-ipc-registry-coverage.test.ts` meta-test asserts data
 * completeness (every URN has a decision: mapped or HTTP-only). This file
 * asserts behavior — that the function actually produces the right
 * discriminated-union shape per input. Both layers matter: a regression in
 * the lookup function (e.g., a wrong field name on the `mapped` variant, a
 * branch swap between `http-only` and `unknown`) would silently produce
 * wrong reason translations downstream.
 */

import { describe, expect, test } from 'bun:test';
import { lookupUrnInRegistry } from './urn-ipc-registry.ts';

describe('lookupUrnInRegistry', () => {
  test('known mapped URN returns mapped with channel + narrow reason', () => {
    const result = lookupUrnInRegistry(
      'urn:ok:error:cursor-not-installed',
      'ok:shell:spawn-cursor',
    );
    expect(result).toEqual({
      kind: 'mapped',
      channel: 'ok:shell:spawn-cursor',
      reason: 'not-installed',
    });
  });

  test('shared URN (path-escape) resolves to channel-specific reason', () => {
    // path-escape exists in cursor's channel map as 'invalid-path' — verifies
    // the channel-keyed shape preserves bespoke per-channel translations.
    const result = lookupUrnInRegistry('urn:ok:error:path-escape', 'ok:shell:spawn-cursor');
    expect(result.kind).toBe('mapped');
    if (result.kind === 'mapped') {
      expect(result.reason).toBe('invalid-path');
    }
  });

  test('URN listed in URN_HTTP_ONLY returns http-only', () => {
    const result = lookupUrnInRegistry(
      'urn:ok:error:internal-server-error',
      'ok:shell:spawn-cursor',
    );
    expect(result.kind).toBe('http-only');
  });

  test('non-URN input returns unknown and preserves the original string', () => {
    const result = lookupUrnInRegistry('not-a-urn', 'ok:shell:spawn-cursor');
    expect(result).toEqual({ kind: 'unknown', problemType: 'not-a-urn' });
  });

  test('empty string returns unknown', () => {
    const result = lookupUrnInRegistry('', 'ok:shell:spawn-cursor');
    expect(result.kind).toBe('unknown');
  });
});
