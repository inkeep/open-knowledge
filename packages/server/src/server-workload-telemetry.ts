import type { ObservableGauge, ObservableResult } from '@opentelemetry/api';
import type { PersistenceQueueDepths } from './persistence.ts';
import { getMeter, onTelemetryShutdown } from './telemetry.ts';

export interface ConnectionCounts {
  websocket: number;
  direct: number;
}

export interface AgentSessionCounts {
  active: number;
  limit: number;
}

const loadedDocsProviders = new Set<() => number>();
const persistenceQueueProviders = new Set<() => PersistenceQueueDepths>();
const bridgeDirtyProbes = new Set<() => boolean>();
const connectionCountsProviders = new Set<() => ConnectionCounts>();
const agentSessionCountsProviders = new Set<() => AgentSessionCounts>();

let cachedLoadedDocsGauge: ObservableGauge | null = null;
let cachedQueueDepthGauge: ObservableGauge | null = null;
let cachedDrainBacklogGauge: ObservableGauge | null = null;
let cachedConnectionsGauge: ObservableGauge | null = null;
let cachedSessionsActiveGauge: ObservableGauge | null = null;
let cachedSessionsLimitGauge: ObservableGauge | null = null;

onTelemetryShutdown(() => {
  cachedLoadedDocsGauge = null;
  cachedQueueDepthGauge = null;
  cachedDrainBacklogGauge = null;
  cachedConnectionsGauge = null;
  cachedSessionsActiveGauge = null;
  cachedSessionsLimitGauge = null;
});

export function registerLoadedDocsProvider(provider: () => number): () => void {
  loadedDocsProviders.add(provider);
  return () => {
    loadedDocsProviders.delete(provider);
  };
}

export function registerPersistenceQueueDepthProvider(
  provider: () => PersistenceQueueDepths,
): () => void {
  persistenceQueueProviders.add(provider);
  return () => {
    persistenceQueueProviders.delete(provider);
  };
}

export function registerBridgeDirtyProbe(probe: () => boolean): () => void {
  bridgeDirtyProbes.add(probe);
  return () => {
    bridgeDirtyProbes.delete(probe);
  };
}

export function registerConnectionCountsProvider(provider: () => ConnectionCounts): () => void {
  connectionCountsProviders.add(provider);
  return () => {
    connectionCountsProviders.delete(provider);
  };
}

export function registerAgentSessionCountsProvider(provider: () => AgentSessionCounts): () => void {
  agentSessionCountsProviders.add(provider);
  return () => {
    agentSessionCountsProviders.delete(provider);
  };
}

export function installServerWorkloadGauges(): void {
  if (
    cachedLoadedDocsGauge &&
    cachedQueueDepthGauge &&
    cachedDrainBacklogGauge &&
    cachedConnectionsGauge &&
    cachedSessionsActiveGauge &&
    cachedSessionsLimitGauge
  ) {
    return;
  }

  if (!cachedLoadedDocsGauge) {
    const gauge = getMeter().createObservableGauge('ok.server.docs.loaded', {
      description:
        'Server-side Y.Docs currently resident in memory (includes synthetic system/config docs).',
      unit: '{documents}',
    });
    gauge.addCallback((result: ObservableResult) => {
      let total = 0;
      for (const provider of loadedDocsProviders) {
        try {
          total += provider();
        } catch {}
      }
      result.observe(total);
    });
    cachedLoadedDocsGauge = gauge;
  }

  if (!cachedQueueDepthGauge) {
    const gauge = getMeter().createObservableGauge('ok.persistence.queue.depth', {
      description:
        'Pending persistence stores by queue. Bounded labels: queue ∈ {branch_deferred, quiescence_deferred}.',
      unit: '{documents}',
    });
    gauge.addCallback((result: ObservableResult) => {
      let branchDeferred = 0;
      let quiescenceDeferred = 0;
      for (const provider of persistenceQueueProviders) {
        try {
          const depths = provider();
          branchDeferred += depths.branchDeferred;
          quiescenceDeferred += depths.quiescenceDeferred;
        } catch {}
      }
      result.observe(branchDeferred, { queue: 'branch_deferred' });
      result.observe(quiescenceDeferred, { queue: 'quiescence_deferred' });
    });
    cachedQueueDepthGauge = gauge;
  }

  if (!cachedDrainBacklogGauge) {
    const gauge = getMeter().createObservableGauge('ok.bridge.drain_backlog', {
      description:
        'Docs whose bridge observers hold an un-settled dirty flag at sample time (settlement is synchronous per drain, so a sustained non-zero value indicates a stuck drain).',
      unit: '{documents}',
    });
    gauge.addCallback((result: ObservableResult) => {
      let dirty = 0;
      for (const probe of bridgeDirtyProbes) {
        try {
          if (probe()) dirty++;
        } catch {}
      }
      result.observe(dirty);
    });
    cachedDrainBacklogGauge = gauge;
  }

  if (!cachedConnectionsGauge) {
    const gauge = getMeter().createObservableGauge('ok.ws.connections.active', {
      description:
        'Live collab connections. Bounded labels: kind ∈ {websocket, direct}. websocket = deduplicated client sockets; direct = in-process DirectConnections (agent sessions + server-held system/config docs).',
      unit: '{connections}',
    });
    gauge.addCallback((result: ObservableResult) => {
      let websocket = 0;
      let direct = 0;
      for (const provider of connectionCountsProviders) {
        try {
          const counts = provider();
          websocket += counts.websocket;
          direct += counts.direct;
        } catch {}
      }
      result.observe(websocket, { kind: 'websocket' });
      result.observe(direct, { kind: 'direct' });
    });
    cachedConnectionsGauge = gauge;
  }

  if (!cachedSessionsActiveGauge || !cachedSessionsLimitGauge) {
    const activeGauge = getMeter().createObservableGauge('ok.sessions.active', {
      description:
        'Live (docName, agentId) agent sessions. Pinned at ok.sessions.limit means new sessions are being refused with 503s.',
      unit: '{sessions}',
    });
    const limitGauge = getMeter().createObservableGauge('ok.sessions.limit', {
      description:
        'Hard cap on live agent sessions (summed across server instances in this process).',
      unit: '{sessions}',
    });
    activeGauge.addCallback((result: ObservableResult) => {
      let active = 0;
      for (const provider of agentSessionCountsProviders) {
        try {
          active += provider().active;
        } catch {}
      }
      result.observe(active);
    });
    limitGauge.addCallback((result: ObservableResult) => {
      let limit = 0;
      for (const provider of agentSessionCountsProviders) {
        try {
          limit += provider().limit;
        } catch {}
      }
      result.observe(limit);
    });
    cachedSessionsActiveGauge = activeGauge;
    cachedSessionsLimitGauge = limitGauge;
  }
}

export function __resetServerWorkloadTelemetryForTests(): void {
  cachedLoadedDocsGauge = null;
  cachedQueueDepthGauge = null;
  cachedDrainBacklogGauge = null;
  cachedConnectionsGauge = null;
  cachedSessionsActiveGauge = null;
  cachedSessionsLimitGauge = null;
  loadedDocsProviders.clear();
  persistenceQueueProviders.clear();
  bridgeDirtyProbes.clear();
  connectionCountsProviders.clear();
  agentSessionCountsProviders.clear();
}
