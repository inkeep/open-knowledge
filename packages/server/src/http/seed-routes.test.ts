import { describe, expect, test } from 'vitest';
import { createSeedRoutes } from './seed-routes.ts';

/**
 * Table-level pins for the seed group's mutating declaration. The wire cannot
 * pin this: the read half of the DNS-rebinding defense applies the identical
 * loopback + workspace-Host checks to every `/api/*` request, so an emptied
 * mutating set changes no composition-suite response — only which gate (and
 * telemetry tag) fires first. The declared membership is pinned here directly
 * against the legacy `MUTATING_ROUTES` membership it reproduces.
 */

function buildGroup() {
  return createSeedRoutes({
    contentDir: '/nonexistent-content',
    // Never dispatched by these pins; the table declaration is what's under test.
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
