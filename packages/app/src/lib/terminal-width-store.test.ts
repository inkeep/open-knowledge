import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_TERMINAL_WIDTH,
  MIN_TERMINAL_WIDTH,
  readTerminalWidth,
  TERMINAL_WIDTH_KEY,
  type TerminalWidthStorage,
  writeTerminalWidth,
} from './terminal-width-store.ts';

function memoryStorage(initial: Record<string, string> = {}): TerminalWidthStorage {
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

describe('readTerminalWidth', () => {
  test('absent key returns default', () => {
    expect(readTerminalWidth(memoryStorage())).toBe(DEFAULT_TERMINAL_WIDTH);
  });

  test('valid stored width is returned', () => {
    const s = memoryStorage({ [TERMINAL_WIDTH_KEY]: '640' });
    expect(readTerminalWidth(s)).toBe(640);
  });

  test('width below floor is clamped to MIN', () => {
    const s = memoryStorage({ [TERMINAL_WIDTH_KEY]: '200' });
    expect(readTerminalWidth(s)).toBe(MIN_TERMINAL_WIDTH);
  });

  test('wide stored width is preserved (no pixel ceiling — layout constraints bound it)', () => {
    const s = memoryStorage({ [TERMINAL_WIDTH_KEY]: '9999' });
    expect(readTerminalWidth(s)).toBe(9999);
  });

  test('non-numeric value falls back to default', () => {
    const s = memoryStorage({ [TERMINAL_WIDTH_KEY]: 'not a number' });
    expect(readTerminalWidth(s)).toBe(DEFAULT_TERMINAL_WIDTH);
  });

  test('empty string falls back to default', () => {
    const s = memoryStorage({ [TERMINAL_WIDTH_KEY]: '' });
    expect(readTerminalWidth(s)).toBe(DEFAULT_TERMINAL_WIDTH);
  });

  test('floating-point string is truncated by parseInt', () => {
    const s = memoryStorage({ [TERMINAL_WIDTH_KEY]: '640.6' });
    expect(readTerminalWidth(s)).toBe(640);
  });
});

describe('writeTerminalWidth', () => {
  test('writes a clamped integer to storage', () => {
    const s = memoryStorage();
    writeTerminalWidth(640, s);
    expect(s.getItem(TERMINAL_WIDTH_KEY)).toBe('640');
  });

  test('clamps to MIN on write below floor', () => {
    const s = memoryStorage();
    writeTerminalWidth(100, s);
    expect(s.getItem(TERMINAL_WIDTH_KEY)).toBe(String(MIN_TERMINAL_WIDTH));
  });

  test('wide width is written unclamped (no pixel ceiling — layout constraints bound it)', () => {
    const s = memoryStorage();
    writeTerminalWidth(9999, s);
    expect(s.getItem(TERMINAL_WIDTH_KEY)).toBe('9999');
  });

  test('rounds floating-point input before write', () => {
    const s = memoryStorage();
    writeTerminalWidth(640.7, s);
    expect(s.getItem(TERMINAL_WIDTH_KEY)).toBe('641');
  });

  test('quota-exceeded throw is swallowed (in-memory only)', () => {
    const throwing: TerminalWidthStorage = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => writeTerminalWidth(640, throwing)).not.toThrow();
  });
});
