
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
