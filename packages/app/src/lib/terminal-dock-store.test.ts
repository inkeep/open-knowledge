import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_TERMINAL_DOCK,
  type DockStorage,
  readTerminalDock,
  TERMINAL_DOCK_KEY,
  writeTerminalDock,
} from './terminal-dock-store';

function memoryStorage(initial?: string): DockStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key) {
      return key === TERMINAL_DOCK_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === TERMINAL_DOCK_KEY) this.value = value;
    },
  };
}

describe('terminal-dock-store', () => {
  test('defaults to right when nothing is stored', () => {
    expect(readTerminalDock(memoryStorage())).toBe('right');
    expect(DEFAULT_TERMINAL_DOCK).toBe('right');
  });

  test('round-trips a bottom dock position', () => {
    const s = memoryStorage();
    writeTerminalDock('bottom', s);
    expect(s.value).toBe('bottom');
    expect(readTerminalDock(s)).toBe('bottom');
  });

  test('round-trips a right dock position', () => {
    const s = memoryStorage('bottom');
    writeTerminalDock('right', s);
    expect(readTerminalDock(s)).toBe('right');
  });

  test('coerces an unknown/corrupted stored value to the right default', () => {
    expect(readTerminalDock(memoryStorage('sideways'))).toBe('right');
    expect(readTerminalDock(memoryStorage(''))).toBe('right');
  });

  test('falls back to the default when storage throws', () => {
    const throwing: DockStorage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
    };
    expect(readTerminalDock(throwing)).toBe('right');
    // Must not throw out to the caller — the write swallows quota/security errors.
    expect(() => writeTerminalDock('bottom', throwing)).not.toThrow();
  });
});
