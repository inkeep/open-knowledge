import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  EmptyRequestSchema,
  getParseHealth,
  type MetricsAgentEffectsSuccess,
  MetricsAgentEffectsSuccessSchema,
  MetricsAgentPresenceSuccessSchema,
  MetricsParseHealthSuccessSchema,
  MetricsReconciliationSuccessSchema,
  type MetricsWatcherRecentSuccess,
  MetricsWatcherRecentSuccessSchema,
} from '@inkeep/open-knowledge-core';
import type { EffectValue } from '../activity-log.ts';
import { type AgentPresenceBroadcaster, BROADCASTER_EVICTION_MS } from '../agent-presence.ts';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import { getWatcherDecisionRingSnapshot } from '../file-watcher.ts';
import type { PinoLogger } from '../logger.ts';
import { isLoopbackAddress } from '../loopback.ts';
import { getMetrics } from '../metrics.ts';
import type { ApiRouteTable } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { getRequestId } from './request-id.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface MetricsRouteDeps {
  hocuspocus: Hocuspocus;
  agentPresenceBroadcaster: AgentPresenceBroadcaster | undefined;
  isAllowedWorkspaceHostHeader: (host: string | undefined) => boolean;
  log: PinoLogger;
}

export interface MetricsRoutes {
  paths: readonly string[];
  table: ApiRouteTable;
}

export function createMetricsRoutes(deps: MetricsRouteDeps): MetricsRoutes {
  const { hocuspocus, agentPresenceBroadcaster, isAllowedWorkspaceHostHeader, log } = deps;

  const handleMetricsReconciliation = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        successResponse(res, 200, MetricsReconciliationSuccessSchema, getMetrics(), {
          handler: 'metrics-reconciliation',
        });
      } catch (e) {
        log.error(
          { err: e, requestId: getRequestId(_req) },
          '[metrics-reconciliation] handler failed',
        );
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'metrics-reconciliation',
          cause: e,
        });
      }
    },
    { handler: 'metrics-reconciliation', method: 'GET', skipBodyParse: true },
  );

  const handleMetricsParseHealth = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        successResponse(res, 200, MetricsParseHealthSuccessSchema, getParseHealth(), {
          handler: 'metrics-parse-health',
        });
      } catch (e) {
        log.error(
          { err: e, requestId: getRequestId(_req) },
          '[metrics-parse-health] handler failed',
        );
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'metrics-parse-health',
          cause: e,
        });
      }
    },
    { handler: 'metrics-parse-health', method: 'GET', skipBodyParse: true },
  );

  async function handleMetricsAgentPresence(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'metrics-agent-presence',
      });
      return;
    }
    if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'metrics-agent-presence',
      });
      return;
    }
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'metrics-agent-presence',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    try {
      const rawPresence = agentPresenceBroadcaster?.getPresenceMap() ?? {};
      const now = Date.now();
      const presence: typeof rawPresence = {};
      for (const [agentId, entry] of Object.entries(rawPresence)) {
        if (now - entry.ts < BROADCASTER_EVICTION_MS) {
          presence[agentId] = entry;
        }
      }
      successResponse(
        res,
        200,
        MetricsAgentPresenceSuccessSchema,
        { presence },
        { handler: 'metrics-agent-presence' },
      );
    } catch (e) {
      log.error(
        { err: e, requestId: getRequestId(req) },
        '[metrics-agent-presence] handler failed',
      );
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'metrics-agent-presence',
        cause: e,
      });
    }
  }

  async function handleMetricsAgentEffects(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'metrics-agent-effects',
      });
      return;
    }
    if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'metrics-agent-effects',
      });
      return;
    }
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'metrics-agent-effects',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    let failingDocName: string | undefined;
    try {
      const effects: MetricsAgentEffectsSuccess['effects'] = [];
      for (const [effectsDocName, document] of hocuspocus.documents) {
        if (isSystemDoc(effectsDocName) || isConfigDoc(effectsDocName)) continue;
        if (!document.share.has('agent-effects')) continue;
        failingDocName = effectsDocName;
        const effectsMap = document.getMap<EffectValue>('agent-effects');
        if (effectsMap.size === 0) continue;
        const entries = [...effectsMap.values()]
          .map((effect) => {
            let insertedChars = 0;
            let deletedChars = 0;
            for (const op of effect.delta) {
              if (typeof op.insert === 'string') insertedChars += op.insert.length;
              else if (op.insert !== undefined) insertedChars += 1;
              if (typeof op.delete === 'number') deletedChars += op.delete;
            }
            return {
              sessionId: effect.sessionId,
              agentType: effect.agent_type,
              ts: effect.timestamp,
              insertedChars,
              deletedChars,
            };
          })
          .sort((a, b) => a.ts - b.ts);
        effects.push({ 'doc.name': effectsDocName, entries });
      }
      effects.sort((a, b) => a['doc.name'].localeCompare(b['doc.name']));
      successResponse(
        res,
        200,
        MetricsAgentEffectsSuccessSchema,
        { effects },
        { handler: 'metrics-agent-effects' },
      );
    } catch (e) {
      log.error({ err: e, 'doc.name': failingDocName }, '[metrics-agent-effects] handler failed');
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'metrics-agent-effects',
        cause: e,
      });
    }
  }

  async function handleMetricsWatcherRecent(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'metrics-watcher-recent',
      });
      return;
    }
    if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'metrics-watcher-recent',
      });
      return;
    }
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'metrics-watcher-recent',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    try {
      const decisions: MetricsWatcherRecentSuccess['decisions'] =
        getWatcherDecisionRingSnapshot().map((record) => ({
          ts: record.ts,
          decision: record.decision,
          kind: record.kind,
          'doc.name': record.path,
          pathRole: record.pathRole,
        }));
      successResponse(
        res,
        200,
        MetricsWatcherRecentSuccessSchema,
        { decisions },
        { handler: 'metrics-watcher-recent' },
      );
    } catch (e) {
      log.error(
        { err: e, requestId: getRequestId(req) },
        '[metrics-watcher-recent] handler failed',
      );
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'metrics-watcher-recent',
        cause: e,
      });
    }
  }

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    '/api/metrics/reconciliation': handleMetricsReconciliation,
    '/api/metrics/parse-health': handleMetricsParseHealth,
    '/api/metrics/agent-presence': handleMetricsAgentPresence,
    '/api/metrics/agent-effects': handleMetricsAgentEffects,
    '/api/metrics/watcher-recent': handleMetricsWatcherRecent,
  };

  const table: ApiRouteTable = {
    resolve(url) {
      const handler = routes[url];
      if (handler) {
        return { template: url, dispatch: (req, res) => handler(req, res) };
      }
      return null;
    },
    isMutating: () => false,
  };

  return {
    paths: Object.keys(routes),
    table,
  };
}
