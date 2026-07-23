import { describe, expect, test } from 'vitest';

describe('useThemeBridge — module surface', () => {
  test('exports the useThemeBridge hook', async () => {
    const mod = await import('./use-theme-bridge');
    expect(typeof mod.useThemeBridge).toBe('function');
  });
});
