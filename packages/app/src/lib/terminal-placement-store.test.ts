import { DEFAULT_TERMINAL_PLACEMENT } from '@inkeep/open-knowledge-core/terminal-layout';
import { describe, expect, test } from 'vitest';
import {
  readTerminalPlacement,
  TERMINAL_PLACEMENT_KEY,
  type TerminalPlacementStorage,
} from './terminal-placement-store.ts';

function memoryStorage(initial: Record<string, string> = {}): TerminalPlacementStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.get(key) ?? null;
    },
  };
}

describe('terminal placement persistence', () => {
  test('a fresh profile starts in the bottom home', () => {
    expect(readTerminalPlacement(memoryStorage())).toBe('bottom');
    expect(DEFAULT_TERMINAL_PLACEMENT).toBe('bottom');
  });

  test.each(['right', 'bottom'] as const)('reads the stored %s home', (placement) => {
    const storage = memoryStorage({ [TERMINAL_PLACEMENT_KEY]: placement });
    expect(readTerminalPlacement(storage)).toBe(placement);
  });

  test.each(['', 'sideways', '{"placement":"right"}'])(
    'defaults malformed or unsupported value %j to bottom',
    (value) => {
      const storage = memoryStorage({ [TERMINAL_PLACEMENT_KEY]: value });
      expect(readTerminalPlacement(storage)).toBe('bottom');
    },
  );
});
