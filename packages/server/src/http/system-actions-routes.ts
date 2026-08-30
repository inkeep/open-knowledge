/**
 * The editor-host system-action pair — `spawn-cursor`, `handoff` — plus the
 * renderer log-ingest sink `client-logs`, routed as one small group (three
 * single-route families, following the `workspace-tools-routes.ts` bundling
 * precedent). What the handlers reach for arrives as
 * {@link SystemActionsRouteDeps}.
 *
 * `spawn-cursor` and `handoff` are not `mutating` members — each carries the
 * loopback-peer + Origin local-op gate INLINE as its first line
 * (`checkLocalOpSecurity`), so both spawn binaries only for same-machine
 * callers while staying on the read posture at the table tier. The
 * workspace-Host half of the DNS-rebinding defense comes from the pipeline's
 * universal `/api/*` read gate, not from the handler. `mutating` below declares
 * only `client-logs`, reproducing the legacy `MUTATING_ROUTES` membership
 * exactly. The handoff handler shares the extension's `installedAgentsCache`
 * scheme probe by reference, so its 60s TTL stays agreed with the
 * `/api/installed-agents` dropdown gate.
 */

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
  /** The extension's shared local-op security gate (emits RFC 9457 on refusal). */
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  /**
   * The extension's shared scheme-probe cache — the SAME object
   * `/api/installed-agents` reads, so the dispatch availability gate and the
   * dropdown's render gate agree (and share the 60s TTL). Narrowed to the one
   * member the handoff dispatch consults.
   */
  installedAgentsCache: Pick<ReturnType<typeof createInstalledAgentsProbe>, 'probeWithCache'>;
}

export function createSystemActionsRoutes(deps: SystemActionsRouteDeps): ApiRouteGroup {
  const { contentDir, log, checkLocalOpSecurity, installedAgentsCache } = deps;

  async function handleHandoffDispatchRoute(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Loopback-only gate — spawns binaries on the user's machine. Same model
    // as `/api/spawn-cursor` and `/api/installed-agents`. The handler also
    // enforces app-name allowlist + URL scheme matching + cursor path
    // containment as defense-in-depth.
    if (!checkLocalOpSecurity(req, res, { handler: 'handoff' })) return;
    try {
      await handleHandoffDispatch(req, res, {
        contentDir,
        platform: process.platform,
        // Share the same cached scheme probe `/api/installed-agents` uses so
        // the Windows/Linux dispatch availability gate agrees with the
        // dropdown's render gate (and reuses its 60s TTL — the row the user
        // just saw enabled decides the click). Unused on macOS.
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
    // Same loopback + DNS-rebinding gate as `/api/installed-agents` — this
    // endpoint spawns a binary on the user's machine, so confining callers
    // to same-origin loopback is load-bearing. Path containment + hardcoded
    // `cursor` binary + `shell:false` argv-array enforce the rest of the
    // security model inside `handleSpawnCursor`. See the file-level comment
    // in `./spawn-cursor-api.ts` for the full threat model.
    // `checkLocalOpSecurity` itself emits RFC 9457 problem+json on rejection.
    if (!checkLocalOpSecurity(req, res, { handler: 'spawn-cursor' })) return;
    try {
      await handleSpawnCursor(req, res, {
        contentDir,
        platform: process.platform,
      });
    } catch (e) {
      // Defensive: `handleSpawnCursor` emits RFC 9457 problem+json for every
      // expected failure mode internally. This catches truly unexpected
      // throws (e.g., a `resolveCursorBinary` injection that throws
      // synchronously) so the client still receives a typed contract
      // response instead of a hung connection. Mirrors `handleInstalledAgentsRoute`.
      if (!res.headersSent) {
        log.error({ err: e, requestId: getRequestId(req) }, '[spawn-cursor] route wrapper failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'spawn-cursor',
          cause: e,
        });
      }
    }
  }

  // Web/browser client-log ingest: the renderer forwarder POSTs batches of
  // captured `console` output here, written to the `renderer` pino subsystem
  // (→ the local-sink server log). Electron captures renderer console in its
  // main process instead. Writes no Y.Docs — exempt from attribution; gated by
  // `checkLocalOpSecurity` (loopback-peer + Origin) as a preBodyGate, with the
  // workspace-Host check added by the shared pipeline mutating gate.
  const handleClientLogs = withValidation(
    ClientLogsRequestSchema,
    async (_req, res, body) => {
      try {
        const logger = getLogger('renderer');
        if (body.droppedSinceLastFlush !== undefined && body.droppedSinceLastFlush > 0) {
          // Gap marker: the forwarder lost entries (buffer overflow / failed
          // POSTs) between the previous delivered batch and this one. Persist
          // it as its own line so a log reader knows the silence was loss,
          // not inactivity.
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
          // Per-entry guard: one entry that trips a pino serialization fault
          // must not drop the rest of the batch (the response still reports the
          // full accepted count — best-effort diagnostics ingest).
          try {
            // Spread client `fields` FIRST so the provenance markers below
            // always win (a client field must not clobber source/transport).
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
          } catch {
            // Skip the malformed entry; continue the batch.
          }
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
