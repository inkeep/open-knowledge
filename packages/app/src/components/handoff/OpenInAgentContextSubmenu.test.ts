import { describe, expect, test } from 'vitest';
import { contextRowHint } from './OpenInAgentContextSubmenu';

describe('contextRowHint', () => {
  test('returns null when workspace metadata is ready', () => {
    expect(contextRowHint(false)).toBeNull();
  });

  test('returns No workspace when workspace metadata is missing', () => {
    expect(contextRowHint(true)).toBe('No workspace');
  });
});

describe('OpenInAgentContextSubmenu module surface', () => {
  test('exports the component and row-hint helper', async () => {
    const mod = await import('./OpenInAgentContextSubmenu');
    expect(typeof mod.OpenInAgentContextSubmenu).toBe('function');
    expect(typeof mod.contextRowHint).toBe('function');
  });
});
