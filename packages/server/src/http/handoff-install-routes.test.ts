import { describe, expect, test } from 'vitest';
import { createHandoffInstallRoutes } from './handoff-install-routes.ts';

function buildGroup() {
  return createHandoffInstallRoutes({
    checkLocalOpSecurity: () => true,
  });
}

describe('createHandoffInstallRoutes table', () => {
  test('registers exactly the one handoff-install path', () => {
    expect([...buildGroup().paths].sort()).toEqual(['/api/install-skill'].sort());
  });

  test('every handoff-install path is mutating (whole-family legacy MUTATING_ROUTES membership)', () => {
    const { table } = buildGroup();
    for (const path of ['/api/install-skill']) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });
});
