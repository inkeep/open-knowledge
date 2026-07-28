import { describe, expect, test } from 'vitest';
import {
  DEFAULT_DOC_PANEL_WIDTH,
  DOC_PANEL_WIDTH_KEY,
  MAX_DOC_PANEL_WIDTH,
  MIN_DOC_PANEL_WIDTH,
  readDocPanelWidth,
  type WidthStorage,
  writeDocPanelWidth,
} from './doc-panel-width-store.ts';

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

describe('readDocPanelWidth', () => {
  test('absent key returns default', () => {
    expect(readDocPanelWidth(memoryStorage())).toBe(DEFAULT_DOC_PANEL_WIDTH);
  });

  test('valid stored width is returned', () => {
    const s = memoryStorage({ [DOC_PANEL_WIDTH_KEY]: '420' });
    expect(readDocPanelWidth(s)).toBe(420);
  });

  test('width below floor is clamped to MIN', () => {
    const s = memoryStorage({ [DOC_PANEL_WIDTH_KEY]: '200' });
    expect(readDocPanelWidth(s)).toBe(MIN_DOC_PANEL_WIDTH);
  });

  test('width above ceiling is clamped to MAX', () => {
    const s = memoryStorage({ [DOC_PANEL_WIDTH_KEY]: '9999' });
    expect(readDocPanelWidth(s)).toBe(MAX_DOC_PANEL_WIDTH);
  });

  test('non-numeric value falls back to default', () => {
    const s = memoryStorage({ [DOC_PANEL_WIDTH_KEY]: 'not a number' });
    expect(readDocPanelWidth(s)).toBe(DEFAULT_DOC_PANEL_WIDTH);
  });

  test('empty string falls back to default', () => {
    const s = memoryStorage({ [DOC_PANEL_WIDTH_KEY]: '' });
    expect(readDocPanelWidth(s)).toBe(DEFAULT_DOC_PANEL_WIDTH);
  });

  test('NaN-producing string falls back to default', () => {
    const s = memoryStorage({ [DOC_PANEL_WIDTH_KEY]: 'NaN' });
    expect(readDocPanelWidth(s)).toBe(DEFAULT_DOC_PANEL_WIDTH);
  });

  test('floating-point value is rounded', () => {
    const s = memoryStorage({ [DOC_PANEL_WIDTH_KEY]: '420.6' });
    expect(readDocPanelWidth(s)).toBe(420);
  });
});

describe('writeDocPanelWidth', () => {
  test('writes a clamped integer to storage', () => {
    const s = memoryStorage();
    writeDocPanelWidth(420, s);
    expect(s.getItem(DOC_PANEL_WIDTH_KEY)).toBe('420');
  });

  test('clamps to MIN on write below floor', () => {
    const s = memoryStorage();
    writeDocPanelWidth(100, s);
    expect(s.getItem(DOC_PANEL_WIDTH_KEY)).toBe(String(MIN_DOC_PANEL_WIDTH));
  });

  test('clamps to MAX on write above ceiling', () => {
    const s = memoryStorage();
    writeDocPanelWidth(9999, s);
    expect(s.getItem(DOC_PANEL_WIDTH_KEY)).toBe(String(MAX_DOC_PANEL_WIDTH));
  });

  test('rounds floating-point input before write', () => {
    const s = memoryStorage();
    writeDocPanelWidth(420.7, s);
    expect(s.getItem(DOC_PANEL_WIDTH_KEY)).toBe('421');
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
    expect(() => writeDocPanelWidth(420, throwing)).not.toThrow();
  });
});
