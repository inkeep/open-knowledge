import { describe, expect, test } from 'vitest';
import {
  AGENTS_PANEL_WIDTH_KEY,
  readAgentsPanelWidth,
  type WidthStorage,
} from './agents-panel-width-store.ts';

function memoryStorage(initial: Record<string, string> = {}): WidthStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.get(key) ?? null;
    },
  };
}

describe('readAgentsPanelWidth', () => {
  test('an absent key reads as no stored width', () => {
    expect(readAgentsPanelWidth(memoryStorage())).toBeNull();
  });

  test('valid stored width is returned', () => {
    const s = memoryStorage({ [AGENTS_PANEL_WIDTH_KEY]: '640' });
    expect(readAgentsPanelWidth(s)).toBe(640);
  });

  test('width below floor is clamped to MIN', () => {
    const s = memoryStorage({ [AGENTS_PANEL_WIDTH_KEY]: '200' });
    expect(readAgentsPanelWidth(s)).toBe(320);
  });

  test('wide stored width is preserved (no pixel ceiling — layout constraints bound it)', () => {
    const s = memoryStorage({ [AGENTS_PANEL_WIDTH_KEY]: '9999' });
    expect(readAgentsPanelWidth(s)).toBe(9999);
  });

  test('a non-numeric value reads as no stored width', () => {
    const s = memoryStorage({ [AGENTS_PANEL_WIDTH_KEY]: 'not a number' });
    expect(readAgentsPanelWidth(s)).toBeNull();
  });

  test('an empty string reads as no stored width', () => {
    const s = memoryStorage({ [AGENTS_PANEL_WIDTH_KEY]: '' });
    expect(readAgentsPanelWidth(s)).toBeNull();
  });

  test('floating-point string is truncated by parseInt', () => {
    const s = memoryStorage({ [AGENTS_PANEL_WIDTH_KEY]: '640.6' });
    expect(readAgentsPanelWidth(s)).toBe(640);
  });
});

test('the storage key keeps its legacy terminal-width value (migration contract)', () => {
  expect(AGENTS_PANEL_WIDTH_KEY).toBe('ok-terminal-width-v1');
});
