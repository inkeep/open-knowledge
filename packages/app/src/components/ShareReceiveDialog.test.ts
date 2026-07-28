import { describe, expect, test } from 'vitest';

describe('ShareReceiveDialog module', () => {
  test('exports the named component', async () => {
    const mod = await import('./ShareReceiveDialog');
    expect(typeof mod.ShareReceiveDialog).toBe('function');
  });
});
