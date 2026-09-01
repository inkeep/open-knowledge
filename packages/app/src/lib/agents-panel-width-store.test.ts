import { afterEach, describe, expect, test } from 'vitest';
import {
  AGENTS_PANEL_WIDTH_KEY,
  DEFAULT_AGENTS_PANEL_WIDTH,
  getInitialAgentsPanelWidth,
  MIN_AGENTS_PANEL_WIDTH,
  readAgentsPanelWidth,
  type WidthStorage,
  writeAgentsPanelWidth,
} from './agents-panel-width-store.ts';

function memoryStorage(initial: Record<string, string> = {}): WidthStorage {
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

describe('readAgentsPanelWidth', () => {
  test('absent key returns default', () => {
    expect(readAgentsPanelWidth(memoryStorage())).toBe(DEFAULT_AGENTS_PANEL_WIDTH);
  });

  test('valid stored width is returned', () => {
    const s = memoryStorage({ [AGENTS_PANEL_WIDTH_KEY]: '640' });
    expect(readAgentsPanelWidth(s)).toBe(640);
  });

  test('width below floor is clamped to MIN', () => {
    const s = memoryStorage({ [AGENTS_PANEL_WIDTH_KEY]: '200' });
    expect(readAgentsPanelWidth(s)).toBe(MIN_AGENTS_PANEL_WIDTH);
  });

  test('wide stored width is preserved (no pixel ceiling — layout constraints bound it)', () => {
    const s = memoryStorage({ [AGENTS_PANEL_WIDTH_KEY]: '9999' });
    expect(readAgentsPanelWidth(s)).toBe(9999);
  });

  test('non-numeric value falls back to default', () => {
    const s = memoryStorage({ [AGENTS_PANEL_WIDTH_KEY]: 'not a number' });
    expect(readAgentsPanelWidth(s)).toBe(DEFAULT_AGENTS_PANEL_WIDTH);
  });

  test('empty string falls back to default', () => {
    const s = memoryStorage({ [AGENTS_PANEL_WIDTH_KEY]: '' });
    expect(readAgentsPanelWidth(s)).toBe(DEFAULT_AGENTS_PANEL_WIDTH);
  });

  test('floating-point string is truncated by parseInt', () => {
    const s = memoryStorage({ [AGENTS_PANEL_WIDTH_KEY]: '640.6' });
    expect(readAgentsPanelWidth(s)).toBe(640);
  });
});

describe('writeAgentsPanelWidth', () => {
  test('writes a clamped integer to storage', () => {
    const s = memoryStorage();
    writeAgentsPanelWidth(640, s);
    expect(s.getItem(AGENTS_PANEL_WIDTH_KEY)).toBe('640');
  });

  test('clamps to MIN on write below floor', () => {
    const s = memoryStorage();
    writeAgentsPanelWidth(100, s);
    expect(s.getItem(AGENTS_PANEL_WIDTH_KEY)).toBe(String(MIN_AGENTS_PANEL_WIDTH));
  });

  test('wide width is written unclamped (no pixel ceiling — layout constraints bound it)', () => {
    const s = memoryStorage();
    writeAgentsPanelWidth(9999, s);
    expect(s.getItem(AGENTS_PANEL_WIDTH_KEY)).toBe('9999');
  });

  test('rounds floating-point input before write', () => {
    const s = memoryStorage();
    writeAgentsPanelWidth(640.7, s);
    expect(s.getItem(AGENTS_PANEL_WIDTH_KEY)).toBe('641');
  });

  test('quota-exceeded throw is swallowed (in-memory only)', () => {
    const throwing: WidthStorage = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => writeAgentsPanelWidth(640, throwing)).not.toThrow();
  });
});

test('the storage key keeps its legacy terminal-width value (migration contract)', () => {
  expect(AGENTS_PANEL_WIDTH_KEY).toBe('ok-terminal-width-v1');
});

describe('getInitialAgentsPanelWidth on a storage-restricted host', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis as object, 'localStorage');
  });

  test('falls back to the default when the localStorage getter throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: access denied');
      },
    });
    expect(getInitialAgentsPanelWidth()).toBe(DEFAULT_AGENTS_PANEL_WIDTH);
  });

  test('falls back to the default when localStorage is absent', () => {
    Reflect.deleteProperty(globalThis as object, 'localStorage');
    expect(getInitialAgentsPanelWidth()).toBe(DEFAULT_AGENTS_PANEL_WIDTH);
  });
});
