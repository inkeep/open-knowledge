import type { IncomingMessage, ServerResponse } from 'node:http';
import { InstallSkillRequestSchema, InstallSkillSuccessSchema } from '@inkeep/open-knowledge-core';
import { isSafeLocalPath } from '../local-op-security.ts';
import { buildAndOpenSkill } from '../skill-install.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface HandoffInstallRouteDeps {
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
}

export function createHandoffInstallRoutes(deps: HandoffInstallRouteDeps): ApiRouteGroup {
  const { checkLocalOpSecurity } = deps;
  const handleInstallSkill = withValidation(
    InstallSkillRequestSchema,
    async (_req, res, body) => {
      if (body.out !== undefined && !isSafeLocalPath(body.out)) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'Output path must be within home directory.',
          { handler: 'install-skill' },
        );
        return;
      }

      try {
        const result = await buildAndOpenSkill({
          ...(body.noOpen !== undefined ? { noOpen: body.noOpen } : {}),
          ...(body.out !== undefined ? { out: body.out } : {}),
        });
        successResponse(res, 200, InstallSkillSuccessSchema, result, {
          handler: 'install-skill',
        });
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to install skill.', {
          handler: 'install-skill',
          cause: err,
        });
      }
    },
    {
      handler: 'install-skill',
      method: 'POST',
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'install-skill' }),
    },
  );

  return createApiRouteGroup(
    { '/api/install-skill': handleInstallSkill },
    { mutating: ['/api/install-skill'] },
  );
}
