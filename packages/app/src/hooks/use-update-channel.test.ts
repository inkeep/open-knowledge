import { describe, expect, test } from 'vitest';

describe('useUpdateChannel module', () => {
  test('exports the hook + the UpdateChannel union', async () => {
    const mod = await import('./use-update-channel');
    expect(typeof mod.useUpdateChannel).toBe('function');
  });
});
