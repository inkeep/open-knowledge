import { describe, expect, test } from 'vitest';
import {
  MIN_TERMINAL_RIGHT_WIDTH,
  PREFERRED_TERMINAL_RIGHT_WIDTH,
  readTerminalRightWidth,
  TERMINAL_RIGHT_WIDTH_KEY,
  type TerminalRightWidthStorage,
  writeTerminalRightWidth,
} from './terminal-right-width-store.ts';

const LEGACY_AGENTS_WIDTH_KEY = 'ok-terminal-width-v1';

function memoryStorage(initial: Record<string, string> = {}): TerminalRightWidthStorage {
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

describe('right-terminal width persistence', () => {
  test('uses a fresh default without reading the agents-panel legacy value', () => {
    const storage = memoryStorage({ [LEGACY_AGENTS_WIDTH_KEY]: '875' });
    expect(readTerminalRightWidth(storage)).toBe(PREFERRED_TERMINAL_RIGHT_WIDTH);
    expect(TERMINAL_RIGHT_WIDTH_KEY).not.toBe(LEGACY_AGENTS_WIDTH_KEY);
  });

  test('keeps a width the user dragged below the preferred width', () => {
    const storage = memoryStorage();
    writeTerminalRightWidth(400, storage);
    expect(readTerminalRightWidth(storage)).toBe(400);
  });

  test('round-trips a supported width', () => {
    const storage = memoryStorage();
    writeTerminalRightWidth(840, storage);
    expect(readTerminalRightWidth(storage)).toBe(840);
  });

  test('clamps a width below the supported floor', () => {
    const storage = memoryStorage({ [TERMINAL_RIGHT_WIDTH_KEY]: '100' });
    expect(readTerminalRightWidth(storage)).toBe(MIN_TERMINAL_RIGHT_WIDTH);
  });

  test.each(['', 'not a number', '840px', 'Infinity'])('defaults malformed value %j', (value) => {
    const storage = memoryStorage({ [TERMINAL_RIGHT_WIDTH_KEY]: value });
    expect(readTerminalRightWidth(storage)).toBe(PREFERRED_TERMINAL_RIGHT_WIDTH);
  });

  test('does not impose a persistence ceiling on a finite width', () => {
    const storage = memoryStorage({ [TERMINAL_RIGHT_WIDTH_KEY]: '2400' });
    expect(readTerminalRightWidth(storage)).toBe(2400);
  });

  test('writes only the fresh width key and leaves the agents-panel key untouched', () => {
    const storage = memoryStorage({ [LEGACY_AGENTS_WIDTH_KEY]: '875' });
    writeTerminalRightWidth(700, storage);
    expect(storage.getItem(TERMINAL_RIGHT_WIDTH_KEY)).toBe('700');
    expect(storage.getItem(LEGACY_AGENTS_WIDTH_KEY)).toBe('875');
  });
});
