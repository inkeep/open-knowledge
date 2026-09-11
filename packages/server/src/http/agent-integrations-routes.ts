import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import {
  AgentIntegrationsApplyRequestSchema,
  AgentIntegrationsApplySuccessSchema,
  type EnvTier,
  type Principal,
} from '@inkeep/open-knowledge-core';
import { type AgentRegistryHostSeam, applyAgentRegistryIntents } from '../agent-registry-apply.ts';
import { collectServerHostSnapshot } from '../agent-registry-probes.ts';
import { extractActorIdentity } from '../extract-actor-identity.ts';
import { isLoopbackRequest } from '../local-op-security.ts';
import type { PinoLogger } from '../logger.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { catchErrors } from './catch-errors.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface AgentIntegrationsRouteDeps {
  log: PinoLogger;
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  getPrincipal: (() => Principal | null) | undefined;
  homeDirOverride: string | undefined;
  projectDir: string | undefined;
  agentIntegrations: AgentRegistryHostSeam | undefined;
}

export function createAgentIntegrationsRoutes(deps: AgentIntegrationsRouteDeps): ApiRouteGroup {
  const {
    log,
    checkLocalOpSecurity,
    getPrincipal,
    homeDirOverride,
    projectDir,
    agentIntegrations,
  } = deps;

  const handleAgentIntegrationsApply = withValidation(
    AgentIntegrationsApplyRequestSchema,
    catchErrors(
      async (req, res, body) => {
        const bodyObj = body as unknown as Record<string, unknown>;
        const actor = extractActorIdentity(bodyObj, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'agent-integrations-apply',
          });
          return;
        }

        const envTier: EnvTier = isLoopbackRequest(req) ? 'local-web' : 'remote-web';
        const { report, snapshot } = await applyAgentRegistryIntents(body.intents, {
          execute: agentIntegrations?.execute,
          env: envTier,
          snapshot: () =>
            collectServerHostSnapshot({ env: envTier, resolve: agentIntegrations?.probe }),
          decisionHome: homeDirOverride ?? homedir(),
          ...(agentIntegrations?.userSkillPresentAnywhere !== undefined
            ? { userSkillPresentAnywhere: agentIntegrations.userSkillPresentAnywhere }
            : {}),
          projectDir,
        });

        log.info(
          {
            actor: actor.kind,
            applied: report.actions.length,
            failed: report.actions.filter((action) => action.errorId !== undefined).length,
            conflicts: report.conflicts.map((conflict) => conflict.kind),
          },
          '[agent-integrations] batch applied',
        );

        successResponse(
          res,
          200,
          AgentIntegrationsApplySuccessSchema,
          { ...report, snapshot },
          { handler: 'agent-integrations-apply' },
        );
      },
      {
        handler: 'agent-integrations-apply',
        title: 'Failed to apply AI tool connections.',
      },
    ),
    {
      handler: 'agent-integrations-apply',
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: 'agent-integrations-apply' }),
    },
  );

  return createApiRouteGroup(
    { '/api/agent-integrations/apply': handleAgentIntegrationsApply },
    { mutating: ['/api/agent-integrations/apply'] },
  );
}
