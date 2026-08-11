import { describe, expect, test } from 'vitest';

/**
 * `use-skills` owns module-level state and wires the invalidation listeners that
 * keep the shared skills list fresh. Wiring them at module scope made importing
 * this module require a DOM — `subscribeToSkillsChanged` calls
 * `window.addEventListener` — so every node-env test that transitively imported
 * it died at load with `window is not defined`, and SSR would have too.
 *
 * This file runs in the node environment on purpose. It is the cheapest guard
 * against re-introducing an import-time DOM dependency here.
 */
describe('use-skills module load', () => {
  test('imports without a DOM', async () => {
    expect(typeof globalThis.window).toBe('undefined');
    const mod = await import('./use-skills');
    expect(typeof mod.useSkills).toBe('function');
  });
});
