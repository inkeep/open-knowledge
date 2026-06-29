import { describe, expect, test } from 'bun:test';
import { sharedExtensions } from './shared';
import { TabFocusTrap } from './tab-focus-trap';

describe('TabFocusTrap — structural contract', () => {
  test("name is exactly 'tabFocusTrap'", () => {
    expect(TabFocusTrap.name).toBe('tabFocusTrap');
  });

  test('priority is 1 so ListItem (100) + Table (60) run first in the keymap chain', () => {
    const ext = TabFocusTrap as unknown as { config: { priority: number } };
    expect(ext.config.priority).toBe(1);
  });

  test('binds both Tab and Shift-Tab, each returning true (consume + preventDefault)', () => {
    const ext = TabFocusTrap as unknown as {
      config: { addKeyboardShortcuts: () => Record<string, () => boolean> };
    };
    const shortcuts = ext.config.addKeyboardShortcuts.call({} as never);
    expect(Object.keys(shortcuts).sort()).toEqual(['Shift-Tab', 'Tab']);
    expect(shortcuts.Tab()).toBe(true);
    expect(shortcuts['Shift-Tab']()).toBe(true);
  });

  test('registered in sharedExtensions so the keymap actually attaches to the editor', () => {
    expect(sharedExtensions).toContain(TabFocusTrap);
  });
});
