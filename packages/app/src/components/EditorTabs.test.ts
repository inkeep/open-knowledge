import { describe, expect, test } from 'vitest';
import * as EditorTabsModule from './EditorTabs';

describe('EditorTabs module', () => {
  test('exports the EditorTabs component', () => {
    expect(typeof EditorTabsModule.EditorTabs).toBe('function');
  });

  test('does NOT re-export tabParts — canonical home is @/editor/editor-tabs', () => {
    expect('tabParts' in EditorTabsModule).toBe(false);
  });

  test('tabParts is exported from @/editor/editor-tabs and parses paths correctly', async () => {
    const mod = await import('@/editor/editor-tabs');
    expect(typeof mod.tabParts).toBe('function');
    const parts = mod.tabParts('meetings/2026/q1/notes', '.md');
    expect(parts.prefix).toBe('meetings/2026/q1/');
    expect(parts.baseName).toBe('notes');
    expect(parts.extension).toBe('.md');
    expect(parts.label).toBe('notes.md');
    const rootParts = mod.tabParts('notes', '.md');
    expect(rootParts.prefix).toBe('');
    expect(rootParts.baseName).toBe('notes');
  });
});
