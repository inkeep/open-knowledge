import { describe, expect, test } from 'vitest';
import { loggerFactory } from '../logger.ts';
import { createSystemActionsRoutes } from './system-actions-routes.ts';

function buildGroup() {
  return createSystemActionsRoutes({
    contentDir: '/nonexistent-content',
    log: loggerFactory.getLogger('test'),
    checkLocalOpSecurity: () => false,
    installedAgentsCache: {
      probeWithCache: () => Promise.resolve(false),
    },
  });
}

describe('createSystemActionsRoutes table', () => {
  test('registers exactly the three system-action paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      ['/api/spawn-cursor', '/api/handoff', '/api/client-logs'].sort(),
    );
  });

  test('only client-logs reproduces legacy MUTATING_ROUTES membership', () => {
    const { table } = buildGroup();
    expect(table.isMutating('/api/client-logs')).toBe(true);
    for (const path of ['/api/spawn-cursor', '/api/handoff']) {
      expect(table.isMutating(path), path).toBe(false);
    }
  });
});
