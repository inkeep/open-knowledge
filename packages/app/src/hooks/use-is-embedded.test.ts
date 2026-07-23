import { describe, expect, test } from 'vitest';

describe('use-is-embedded module', () => {
  test('exports useIsEmbedded as a function', async () => {
    const mod = await import('./use-is-embedded.ts');
    expect(typeof mod.useIsEmbedded).toBe('function');
  });
});
