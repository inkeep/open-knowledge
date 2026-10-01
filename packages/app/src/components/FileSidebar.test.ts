import { describe, expect, test } from 'vitest';
import { FileSidebar, isInteractiveSidebarControl } from './FileSidebar';

describe('FileSidebar module', () => {
  test('exports the FileSidebar component', () => {
    expect(typeof FileSidebar).toBe('function');
  });

  test('exports isInteractiveSidebarControl for the sidebar surface context-menu opt-out', () => {
    expect(typeof isInteractiveSidebarControl).toBe('function');
  });
});

describe('isInteractiveSidebarControl — runtime guard clauses', () => {
  test('returns false for null target', () => {
    expect(isInteractiveSidebarControl(null)).toBe(false);
  });

  test('returns false for non-Element EventTarget shapes', () => {
    expect(isInteractiveSidebarControl({} as EventTarget)).toBe(false);
    const fakeElement = { closest: () => ({}) } as unknown as EventTarget;
    expect(isInteractiveSidebarControl(fakeElement)).toBe(false);
  });
});
