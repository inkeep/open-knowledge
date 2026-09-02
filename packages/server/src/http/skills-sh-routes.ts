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
