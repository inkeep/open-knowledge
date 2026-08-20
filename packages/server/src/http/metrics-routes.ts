/**
 * The metrics read family — `metrics-reconciliation`, `metrics-parse-health`,
 * `metrics-agent-presence`, `metrics-agent-effects`, `metrics-watcher-recent`
 * — the second natively-routed group. What the handlers close over arrives as
 * {@link MetricsRouteDeps}.
 *
 * Being the SECOND group is the point: the extension aggregates every group
 * into one `nativeApi` handle (paths concatenated, per-group pipeline
 * dispatches chained), so this file proves the multi-group composition the
 * first group deferred.
 *
 * The agent-presence / agent-effects / watcher-recent handlers carry their
 * loopback + Host gates INLINE, ahead of method dispatch (OWASP ASVS V4.1.1 —
 * a bad Host must never learn the verb via 405). That contract is different
 * from the pipeline's `isMutating` mechanism, which gates before dispatch but
 * ALSO before the per-route 404/405 machinery for mutating writes — so these
 * gates deliberately stay in the handler bodies and `isMutating` stays false.
 * The Host predicate arrives as a dep because the extension widens it when
 * the server is exposed (server.allowExternal + server.externalUrl) — the
 * tunnel's public Host is as legitimate as loopback.
 */

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
  /**
   * The extension's exposure-widened workspace-Host predicate — when the
   * server is exposed, the tunnel's public Host passes alongside the loopback
   * names.
   */
  isAllowedWorkspaceHostHeader: (host: string | undefined) => boolean;
  log: PinoLogger;
}

export interface MetricsRoutes {
  /** Hono patterns for the native mount (`NativeApiHandle.paths`). */
  paths: readonly string[];
  /** The group's view for the shared /api/* admission pipeline. */
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
    // Loopback + Host-header gate — matches /api/workspace. The presence map
    // exposes per-agent identity (`displayName` — operator-configured AGENT
    // label) and the workspace-relative path each agent is currently writing
    // to (`currentDoc`). Those are local-editing-only signals; if a user
    // deploys to `0.0.0.0` / reverse-proxies the port, cross-origin pages or
    // LAN peers MUST NOT be able to read the map. Authorization runs before
    // method dispatch so a bad Host never leaks "verb the endpoint expects"
    // via 405 (same pattern + rationale as handleWorkspace — see its
    // comment block for the ASVS / DNS-rebinding background).
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
      // Pre-filter stale entries using the same threshold the broadcaster
      // uses for opportunistic eviction (runs inside setPresence). Eviction
      // is write-triggered — if the last agent disconnects without the
      // keepalive close firing (proxy ate the frame, `-9` kill) and no other
      // agent writes after, the raw map keeps the zombie entry. Clients
      // already filter with their own 5s TTL so this is invisible to the
      // bar, but `/api/metrics/agent-presence` would otherwise lie to
      // operators. Filtering here matches what a "live" read returns
      // without paying for a sparse timer.
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
    // Diagnostic view of the per-doc `agent-effects` ring buffers, which
    // otherwise live only inside live Y.Docs and are invisible to bundles.
    // Loopback + Host-header gated with auth-before-method-dispatch ordering
    // — same pattern + rationale as `handleMetricsAgentPresence` (per-agent
    // identity plus per-doc write timing are local-editing-only signals).
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
    // Tracks the doc being summarized so a throw in the per-doc reduction (e.g.
    // a malformed `EffectValue` from an older schema) names its source in the
    // catch log. Rides the `doc.name` key the bundle redactor hashes.
    let failingDocName: string | undefined;
    try {
      // Currently-loaded docs only — iterating `hocuspocus.documents` never
      // materializes an unloaded doc. The `share.has` probe avoids even
      // creating the lazy Y.Map placeholder on docs no agent ever wrote to.
      const effects: MetricsAgentEffectsSuccess['effects'] = [];
      for (const [effectsDocName, document] of hocuspocus.documents) {
        if (isSystemDoc(effectsDocName) || isConfigDoc(effectsDocName)) continue;
        if (!document.share.has('agent-effects')) continue;
        failingDocName = effectsDocName;
        const effectsMap = document.getMap<EffectValue>('agent-effects');
        if (effectsMap.size === 0) continue;
        // Deltas reduce to character counts: the diagnostic signal is who
        // wrote how much to which doc and when. Raw delta text is user
        // content and stays in the live doc.
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
        // The doc name rides under the literal `doc.name` key — the key the
        // diagnostics-bundle redactor hashes — so a staged copy of this
        // response is anonymized by the existing pass.
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
    // Diagnostic view of the file-watcher's recent-decisions ring — the
    // record of which disk events were dispatched, skipped as self-writes,
    // or dropped (and why), which otherwise lives only in server memory.
    // Loopback + Host-header gated with auth-before-method-dispatch ordering
    // — same pattern + rationale as `handleMetricsAgentEffects` (which files
    // changed on this machine, and when, is a local-editing-only signal).
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
      // Ring paths are already normalized (last two segments) at record
      // time. The wire carries them under the literal `doc.name` key — the
      // key the diagnostics-bundle redactor hashes — so a staged copy of
      // this response is anonymized by the existing pass.
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
    // None of these routes rode the legacy MUTATING_ROUTES gate. The three
    // gated diagnostics enforce loopback + Host INLINE, before method
    // dispatch (gate-before-405) — a different contract from the pipeline's
    // mutating gate, so they deliberately do not migrate onto it.
    isMutating: () => false,
  };

  return {
    paths: Object.keys(routes),
    table,
  };
}
