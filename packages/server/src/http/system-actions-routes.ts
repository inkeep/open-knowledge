import type { IncomingMessage, ServerResponse } from 'node:http';
import { ClientLogsRequestSchema, ClientLogsSuccessSchema } from '@inkeep/open-knowledge-core';
import type { createInstalledAgentsProbe } from '../handoff-api.ts';
import { handleHandoffDispatch } from '../handoff-dispatch-api.ts';
import { getLogger, type PinoLogger } from '../logger.ts';
import { handleSpawnCursor } from '../spawn-cursor-api.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { getRequestId } from './request-id.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface SystemActionsRouteDeps {
  contentDir: string;
  log: PinoLogger;
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  installedAgentsCache: Pick<ReturnType<typeof createInstalledAgentsProbe>, 'probeWithCache'>;
}

export function createSystemActionsRoutes(deps: SystemActionsRouteDeps): ApiRouteGroup {
  const { contentDir, log, checkLocalOpSecurity, installedAgentsCache } = deps;

  async function handleHandoffDispatchRoute(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'handoff' })) return;
    try {
      await handleHandoffDispatch(req, res, {
        contentDir,
        platform: process.platform,
        isSchemeRegistered: installedAgentsCache.probeWithCache,
      });
    } catch (e) {
      if (!res.headersSent) {
        log.error({ err: e, requestId: getRequestId(req) }, '[handoff] route wrapper failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'handoff',
          cause: e,
        });
      }
    }
  }

  async function handleSpawnCursorRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'spawn-cursor' })) return;
    try {
      await handleSpawnCursor(req, res, {
        contentDir,
        platform: process.platform,
      });
    } catch (e) {
      if (!res.headersSent) {
        log.error({ err: e, requestId: getRequestId(req) }, '[spawn-cursor] route wrapper failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'spawn-cursor',
          cause: e,
        });
      }
    }
  }

  const handleClientLogs = withValidation(
    ClientLogsRequestSchema,
    async (_req, res, body) => {
      try {
        const logger = getLogger('renderer');
        if (body.droppedSinceLastFlush !== undefined && body.droppedSinceLastFlush > 0) {
          logger.warn(
            {
              source: 'renderer-console',
              transport: 'web',
              event: 'client-log-entries-dropped',
              droppedSinceLastFlush: body.droppedSinceLastFlush,
            },
            'client-log-entries-dropped',
          );
        }
        for (const entry of body.entries) {
          try {
            logger[entry.level](
              {
                ...entry.fields,
                source: 'renderer-console',
                transport: 'web',
                ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
                ...(entry.lineNumber !== undefined ? { lineNumber: entry.lineNumber } : {}),
                ...(entry.ts !== undefined ? { clientTs: entry.ts } : {}),
              },
              entry.event ?? entry.message,
            );
          } catch {}
        }
        successResponse(
          res,
          200,
          ClientLogsSuccessSchema,
          { accepted: body.entries.length },
          { handler: 'client-logs' },
        );
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'client-logs',
          cause: err,
        });
      }
    },
    {
      handler: 'client-logs',
      method: 'POST',
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'client-logs' }),
    },
  );

  return createApiRouteGroup(
    {
      '/api/spawn-cursor': handleSpawnCursorRoute,
      '/api/handoff': handleHandoffDispatchRoute,
      '/api/client-logs': handleClientLogs,
    },
    { mutating: ['/api/client-logs'] },
  );
}
