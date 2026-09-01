import { describe, expect, test } from 'vitest';
import { createSeedRoutes } from './seed-routes.ts';

function buildGroup() {
  return createSeedRoutes({
    contentDir: '/nonexistent-content',
    checkLocalOpSecurity: () => false,
  });
}

describe('createSeedRoutes table', () => {
  test('registers exactly the four seed paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      [
        '/api/seed/plan',
        '/api/seed/apply',
        '/api/seed/install-pack-skill',
        '/api/seed/packs',
      ].sort(),
    );
  });

  test('legacy MUTATING_ROUTES members are mutating; the reads are not', () => {
    const { table } = buildGroup();
    for (const path of ['/api/seed/apply', '/api/seed/install-pack-skill']) {
      expect(table.isMutating(path), path).toBe(true);
    }
    for (const path of ['/api/seed/plan', '/api/seed/packs']) {
      expect(table.isMutating(path), path).toBe(false);
    }
  });
});
