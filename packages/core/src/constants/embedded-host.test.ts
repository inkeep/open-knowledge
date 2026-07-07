import { describe, expect, test } from 'bun:test';
import { detectEmbeddedHostFromBrowser, type EmbeddedHost } from './embedded-host.ts';

function detectFromUA(ua: string): EmbeddedHost {
  const original = navigator.userAgent;
  Object.defineProperty(navigator, 'userAgent', {
    value: ua,
    writable: true,
    configurable: true,
  });
  try {
    return detectEmbeddedHostFromBrowser();
  } finally {
    Object.defineProperty(navigator, 'userAgent', {
      value: original,
      configurable: true,
    });
  }
}

const CHROME_VANILLA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

describe('detectEmbeddedHostFromBrowser', () => {
  test('vanilla Chrome UA returns null', () => {
    expect(detectFromUA(CHROME_VANILLA)).toBeNull();
  });

  describe('Cursor detection', () => {
    test('bare Cursor token', () => {
      expect(detectFromUA(`${CHROME_VANILLA} Cursor/1.2.3`)).toBe('cursor');
    });

    test('Cursor with flavor parenthetical', () => {
      expect(detectFromUA(`${CHROME_VANILLA} Cursor(Beta)/1.0.0`)).toBe('cursor');
    });

    test('Cursor with hyphenated flavor (e.g. Nightly-2)', () => {
      // Regex must accept hyphens, dots, spaces inside the parenthetical —
      // [^)]+ rather than \w+ (which is alnum+underscore only).
      expect(detectFromUA(`${CHROME_VANILLA} Cursor(Nightly-2)/1.0`)).toBe('cursor');
    });
  });

  describe('Codex detection', () => {
    test('bare Codex token', () => {
      expect(detectFromUA(`${CHROME_VANILLA} Codex/26.0.0`)).toBe('codex');
    });

    test('Codex with flavor parenthetical (OQ-EP1 regression)', () => {
      expect(detectFromUA(`${CHROME_VANILLA} Codex(Dev)/26.513.31313`)).toBe('codex');
    });

    test('Codex with dotted flavor (e.g. Dev.preview)', () => {
      expect(detectFromUA(`${CHROME_VANILLA} Codex(Dev.preview)/26.5.0`)).toBe('codex');
    });
  });

  describe('Claude detection', () => {
    test('bare Claude token', () => {
      expect(detectFromUA(`${CHROME_VANILLA} Claude/1.5.0`)).toBe('claude-desktop');
    });

    test('Claude with flavor parenthetical', () => {
      expect(detectFromUA(`${CHROME_VANILLA} Claude(Canary)/1.0.0`)).toBe('claude-desktop');
    });
  });

  test('first matching token wins when multiple are present', () => {
    expect(detectFromUA(`${CHROME_VANILLA} Cursor/1.0 Codex/26.0`)).toBe('cursor');
  });

  test('partial token names do not match', () => {
    expect(detectFromUA(`${CHROME_VANILLA} MyCursor/1.0`)).toBeNull();
    expect(detectFromUA(`${CHROME_VANILLA} SuperCodex/1.0`)).toBeNull();
  });

  test('token without version slash does not match', () => {
    expect(detectFromUA(`${CHROME_VANILLA} Cursor`)).toBeNull();
    expect(detectFromUA(`${CHROME_VANILLA} Codex`)).toBeNull();
  });
});
