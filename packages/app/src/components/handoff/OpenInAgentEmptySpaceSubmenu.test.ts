import { describe, expect, test } from 'vitest';
import { emptySpaceRowHint } from './OpenInAgentEmptySpaceSubmenu';

describe('OpenInAgentEmptySpaceSubmenu module surface', () => {
  test('exports the component and row-hint helper', async () => {
    const mod = await import('./OpenInAgentEmptySpaceSubmenu');
    expect(typeof mod.OpenInAgentEmptySpaceSubmenu).toBe('function');
    expect(typeof mod.emptySpaceRowHint).toBe('function');
  });
});

describe('emptySpaceRowHint', () => {
  test('returns No workspace when input is missing', () => {
    expect(emptySpaceRowHint(true)).toBe('No workspace');
  });

  test('returns null when input is ready', () => {
    expect(emptySpaceRowHint(false)).toBeNull();
  });
});
