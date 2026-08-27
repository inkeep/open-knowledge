import { describe, expect, test } from 'vitest';
import { loggerFactory } from '../logger.ts';
import { createSkillsShRoutes } from './skills-sh-routes.ts';

/**
 * Table-level pins for the skills.sh proxy group's mutating declaration. The
 * wire cannot pin this: the read half of the DNS-rebinding defense applies
 * the identical loopback + workspace-Host checks to every `/api/*` request,
 * so an emptied mutating set changes no composition-suite response — only
 * which gate (and telemetry tag) fires first. The declared membership is
 * pinned here directly against the legacy `MUTATING_ROUTES` membership it
 * reproduces.
 */

function buildGroup() {
  return createSkillsShRoutes({
    log: loggerFactory.getLogger('test'),
    skillsHome: '/nonexistent-skills-home',
    projectDir: undefined,
    contentDir: '/nonexistent-content',
    resolveSkillDirForRead: () => null,
  });
}

describe('createSkillsShRoutes table', () => {
  test('registers exactly the seven proxy paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      [
        '/api/skills/search',
        '/api/skills/popular',
        '/api/skills/publisher',
        '/api/skills/detail',
        '/api/skills/preview',
        '/api/skills/discover',
        '/api/skills/resolve-ref',
      ].sort(),
    );
  });

  test('the clone-egress trio is mutating; the four proxy reads are not', () => {
    const { table } = buildGroup();
    for (const path of ['/api/skills/preview', '/api/skills/discover', '/api/skills/resolve-ref']) {
      expect(table.isMutating(path), path).toBe(true);
    }
    for (const path of [
      '/api/skills/search',
      '/api/skills/popular',
      '/api/skills/publisher',
      '/api/skills/detail',
    ]) {
      expect(table.isMutating(path), path).toBe(false);
    }
  });
});
