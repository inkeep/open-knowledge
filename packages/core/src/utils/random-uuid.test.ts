import { afterEach, describe, expect, test, vi } from 'vitest';
import { randomUUID } from './random-uuid.ts';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('randomUUID', () => {
  test('uses native crypto.randomUUID when available (secure context / Node)', () => {
    const native = vi.fn(() => '11111111-1111-4111-8111-111111111111');
    vi.stubGlobal('crypto', { randomUUID: native });
    expect(randomUUID()).toBe('11111111-1111-4111-8111-111111111111');
    expect(native).toHaveBeenCalledOnce();
  });

  test('falls back to getRandomValues when randomUUID is absent (insecure http origin)', () => {
    // Simulate a plain-HTTP non-localhost origin: getRandomValues exists,
    // crypto.randomUUID does not. This is the tab-identity module-load crash.
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => real.getRandomValues(a),
    });
    const id = randomUUID();
    expect(id).toMatch(V4);
    // Distinct across calls (probabilistically certain for 122 random bits).
    expect(randomUUID()).not.toBe(id);
  });

  test('fallback always stamps the version-4 and variant nibbles', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => real.getRandomValues(a),
    });
    for (let i = 0; i < 500; i++) {
      const id = randomUUID();
      expect(id).toMatch(V4);
      expect(id[14]).toBe('4');
      expect('89ab').toContain(id[19]);
    }
  });

  test('does not throw even with no Web Crypto at all', () => {
    vi.stubGlobal('crypto', undefined);
    expect(randomUUID()).toMatch(V4);
  });
});
