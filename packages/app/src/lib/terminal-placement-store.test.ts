import { describe, expect, test } from 'vitest';
import {
  DEFAULT_TERMINAL_PLACEMENT,
  readTerminalPlacement,
  TERMINAL_PLACEMENT_KEY,
  type TerminalPlacementStorage,
  writeTerminalPlacement,
} from './terminal-placement-store.ts';

function memoryStorage(initial: Record<string, string> = {}): TerminalPlacementStorage {
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

describe('terminal placement persistence', () => {
  test('a fresh profile starts in the bottom home', () => {
    expect(readTerminalPlacement(memoryStorage())).toBe('bottom');
    expect(DEFAULT_TERMINAL_PLACEMENT).toBe('bottom');
  });

  test.each(['right', 'bottom'] as const)('round-trips the %s home', (placement) => {
    const storage = memoryStorage();
    writeTerminalPlacement(placement, storage);
    expect(storage.getItem(TERMINAL_PLACEMENT_KEY)).toBe(placement);
    expect(readTerminalPlacement(storage)).toBe(placement);
  });

  test.each([
    '',
    'sideways',
    '{"placement":"right"}',
  ])('defaults malformed or unsupported value %j to bottom', (value) => {
    const storage = memoryStorage({ [TERMINAL_PLACEMENT_KEY]: value });
    expect(readTerminalPlacement(storage)).toBe('bottom');
  });
});
