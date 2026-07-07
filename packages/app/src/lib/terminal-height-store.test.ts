import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_TERMINAL_HEIGHT,
  type HeightStorage,
  MIN_TERMINAL_HEIGHT,
  readTerminalHeight,
  TERMINAL_HEIGHT_KEY,
  writeTerminalHeight,
} from './terminal-height-store.ts';

function memoryStorage(initial: Record<string, string> = {}): HeightStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

// A tall viewport whose 50vh ceiling (500) sits above the ~1/3 default (333) so
// the default/min cases are exercised without the vh clamp interfering.
const TALL = 1000;
// Literal, NOT derived from the fraction constant: pins the ~1/3 contract so a
// regression to the fraction (e.g. 1/3 → 1/4) is actually caught instead of
// moving both sides of the assertion in lockstep.
const TALL_DEFAULT = 333;

describe('readTerminalHeight', () => {
  test('absent key returns the ~1/3-viewport default (1000 → 333)', () => {
    expect(readTerminalHeight(memoryStorage(), TALL)).toBe(TALL_DEFAULT);
  });

  test('default below the floor on a short viewport clamps up to MIN (300 → 100 → 120)', () => {
    // vh/3 = 100 lands under the 120px floor.
    expect(readTerminalHeight(memoryStorage(), 300)).toBe(MIN_TERMINAL_HEIGHT);
  });

  test('valid stored height is returned', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: '300' });
    expect(readTerminalHeight(s, TALL)).toBe(300);
  });

  test('height below floor is clamped to MIN', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: '80' });
    expect(readTerminalHeight(s, TALL)).toBe(MIN_TERMINAL_HEIGHT);
  });

  test('height above the 50vh ceiling is clamped to half the viewport', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: '9999' });
    expect(readTerminalHeight(s, TALL)).toBe(500);
  });

  test('ceiling tracks the viewport (50vh), not a fixed pixel cap', () => {
    // 400 fits under a 1000px viewport (ceiling 500) but exceeds a 600px one
    // (ceiling 300) — proving the cap is viewport-relative.
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: '400' });
    expect(readTerminalHeight(s, 1000)).toBe(400);
    expect(readTerminalHeight(s, 600)).toBe(300);
  });

  test('non-numeric value falls back to default', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: 'not a number' });
    expect(readTerminalHeight(s, TALL)).toBe(TALL_DEFAULT);
  });

  test('empty string falls back to default', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: '' });
    expect(readTerminalHeight(s, TALL)).toBe(TALL_DEFAULT);
  });

  test('floating-point value is rounded', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: '240.6' });
    expect(readTerminalHeight(s, TALL)).toBe(240);
  });

  test('throwing storage falls back to the fixed pixel default', () => {
    const throwing: HeightStorage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {},
    };
    expect(readTerminalHeight(throwing, TALL)).toBe(DEFAULT_TERMINAL_HEIGHT);
  });
});

describe('writeTerminalHeight', () => {
  test('writes a clamped integer to storage', () => {
    const s = memoryStorage();
    writeTerminalHeight(300, s, TALL);
    expect(s.getItem(TERMINAL_HEIGHT_KEY)).toBe('300');
  });

  test('clamps to MIN on write below floor', () => {
    const s = memoryStorage();
    writeTerminalHeight(80, s, TALL);
    expect(s.getItem(TERMINAL_HEIGHT_KEY)).toBe(String(MIN_TERMINAL_HEIGHT));
  });

  test('clamps to the 50vh ceiling on write above it', () => {
    const s = memoryStorage();
    writeTerminalHeight(9999, s, 600);
    expect(s.getItem(TERMINAL_HEIGHT_KEY)).toBe('300');
  });

  test('rounds floating-point input before write', () => {
    const s = memoryStorage();
    writeTerminalHeight(240.7, s, TALL);
    expect(s.getItem(TERMINAL_HEIGHT_KEY)).toBe('241');
  });

  test('quota-exceeded throw is swallowed (in-memory only)', () => {
    const throwing: HeightStorage = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => writeTerminalHeight(240, throwing, TALL)).not.toThrow();
  });
});
