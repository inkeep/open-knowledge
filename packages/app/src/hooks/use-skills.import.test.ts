import { describe, expect, test } from 'vitest';

describe('use-skills module load', () => {
  test('imports without a DOM', async () => {
    expect(typeof globalThis.window).toBe('undefined');
    const mod = await import('./use-skills');
    expect(typeof mod.useSkills).toBe('function');
  });
});
