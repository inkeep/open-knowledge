/**
 * The skills.sh proxy family — `skills/search`, `skills/popular`,
 * `skills/publisher`, `skills/detail` (reads) plus `skills/preview`,
 * `skills/discover`, `skills/resolve-ref` (mutating) — natively routed as one
 * group. The handler bodies were already lifted into
 * `skills-sh-handlers.ts`; this factory closes the loop by owning their route
 * table so the extension's legacy record loses the paths in the same change.
 *
 * The preview/discover/resolve-ref trio are read-shaped GETs, but each
 * triggers an arbitrary `git clone` (network egress) + local SKILL.md reads,
 * so they ride the loopback/host mutating gate, not the read posture — the
 * same legacy `MUTATING_ROUTES` membership, declared on the table. The four
 * proxy reads stay on the read posture.
 */

import type { SkillsShHandlerDeps } from '../skills-sh-handlers.ts';
import { createSkillsShHandlers } from '../skills-sh-handlers.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';

export type SkillsShRouteDeps = SkillsShHandlerDeps;

export function createSkillsShRoutes(deps: SkillsShRouteDeps): ApiRouteGroup {
  const {
    handleSkillsSearch,
    handleSkillsPopular,
    handleSkillsPublisher,
    handleSkillsDetail,
    handleSkillsPreview,
    handleSkillsDiscover,
    handleSkillsResolveRef,
  } = createSkillsShHandlers(deps);

  return createApiRouteGroup(
    {
      '/api/skills/search': handleSkillsSearch,
      '/api/skills/popular': handleSkillsPopular,
      '/api/skills/publisher': handleSkillsPublisher,
      '/api/skills/detail': handleSkillsDetail,
      '/api/skills/preview': handleSkillsPreview,
      '/api/skills/discover': handleSkillsDiscover,
      '/api/skills/resolve-ref': handleSkillsResolveRef,
    },
    { mutating: ['/api/skills/preview', '/api/skills/discover', '/api/skills/resolve-ref'] },
  );
}
