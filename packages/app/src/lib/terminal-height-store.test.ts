import { describe, expect, test } from 'vitest';
import {
  type HeightStorage,
  readTerminalHeight,
  TERMINAL_HEIGHT_KEY,
} from './terminal-height-store.ts';

function memoryStorage(initial: Record<string, string> = {}): HeightStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.get(key) ?? null;
    },
  };
}

const TALL = 1000;

describe('readTerminalHeight', () => {
  test('an absent key reads as no stored height', () => {
    expect(readTerminalHeight(memoryStorage(), TALL)).toBeNull();
  });

  test('valid stored height is returned', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: '300' });
    expect(readTerminalHeight(s, TALL)).toBe(300);
  });

  test('height below floor is clamped to MIN', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: '80' });
    expect(readTerminalHeight(s, TALL)).toBe(120);
  });

  test('height above the 50vh ceiling is clamped to half the viewport', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: '9999' });
    expect(readTerminalHeight(s, TALL)).toBe(500);
  });

  test('ceiling tracks the viewport (50vh), not a fixed pixel cap', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: '400' });
    expect(readTerminalHeight(s, 1000)).toBe(400);
    expect(readTerminalHeight(s, 600)).toBe(300);
  });

  test('a non-numeric value reads as no stored height', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: 'not a number' });
    expect(readTerminalHeight(s, TALL)).toBeNull();
  });

  test('an empty string reads as no stored height', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: '' });
    expect(readTerminalHeight(s, TALL)).toBeNull();
  });

  test('floating-point value is rounded', () => {
    const s = memoryStorage({ [TERMINAL_HEIGHT_KEY]: '240.6' });
    expect(readTerminalHeight(s, TALL)).toBe(240);
  });
});
