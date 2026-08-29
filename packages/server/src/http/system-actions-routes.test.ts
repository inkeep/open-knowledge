import { describe, expect, test } from 'vitest';
import { loggerFactory } from '../logger.ts';
import { createSystemActionsRoutes } from './system-actions-routes.ts';

/**
 * Table-level pins for the system-actions group's mutating declaration. The
 * wire cannot pin this: the read half of the DNS-rebinding defense applies
 * the identical loopback + workspace-Host checks to every `/api/*` request,
 * so an emptied mutating set changes no composition-suite response — only
 * which gate (and telemetry tag) fires first. The declared membership is
 * pinned here directly against the legacy `MUTATING_ROUTES` membership it
 * reproduces — `spawn-cursor` and `handoff` were deliberately NOT members
 * (their loopback confinement is the in-handler `checkLocalOpSecurity`
 * first line), and that posture must survive the lift byte-for-byte.
 */

function buildGroup() {
  return createSystemActionsRoutes({
    contentDir: '/nonexistent-content',
    log: loggerFactory.getLogger('test'),
    // Never dispatched by these pins; the table declaration is what's under test.
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
