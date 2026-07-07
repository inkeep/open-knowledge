/**
 * `useActivityPanel` — data layer for the Agent Activity Panel.
 *
 * Responsibilities:
 *   1. On `connectionId` set: fetch `GET /api/agent-activity?agentId=…`.
 *   2. Subscribe to CC1 `'session-activity'` via `subscribeToDocumentsChanged`
 *      and re-fetch after a 500 ms trailing-edge debounce.
 *   3. Subscribe to `__system__` awareness for `agentPresence` and expose a
 *      `writingDocs` set so file rows can show a "writing…" indicator.
 *   4. Provide `fetchBurstDiff(docName, stackIndex)` — lazy per-burst diff
 *      fetch with a component-scoped cache so re-expand doesn't re-fetch.
 *   5. Cancelled-flag semantics: an in-flight fetch that completes AFTER the
 *      connectionId swapped or the component unmounted must NOT update state.
 *
 * Inert mode: `connectionId === null` → no fetches, no subscriptions. Returns
 * `{ data: null, status: 'idle', error: null }` and no-op callbacks.
 *
 * Data source rationale lives in `packages/server/src/agent-activity.ts`.
 * This hook is a pure consumer — never mutates Y.Doc state.
 */
import {
  type ActivityAgentHeader,
  type ActivityBurst,
  type ActivityFile,
  AgentActivitySuccessSchema,
  AgentBurstDiffSuccessSchema,
  ProblemDetailsSchema,
} from '@inkeep/open-knowledge-core';
import { useEffect, useRef, useState } from 'react';
import { useDocumentContext } from '@/editor/DocumentContext';
import { HttpResponseParseError } from '@/editor/http-client';
import { hasAgentPresenceShape } from '@/lib/agent-presence';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';
import { LruStringCache } from '@/lib/lru-string-cache';

// ---------------------------------------------------------------
// Types — schema-inferred via `z.infer` in core. Re-exported under the
// historical names (`BurstData`, `FileData`) for callers that already import
// these symbols, so the server schema is the single source of truth and
// drift between client + server is impossible.
// ---------------------------------------------------------------

export type BurstData = ActivityBurst;
export type FileData = ActivityFile;

interface ActivityPanelData {
  sessionAlive: boolean;
  agent: ActivityAgentHeader | null;
  files: ActivityFile[];
  /** Set of docNames this agent is currently writing to. */
  writingDocs: Set<string>;
}

type ActivityPanelStatus = 'idle' | 'loading' | 'ready' | 'error';

interface UseActivityPanelResult {
  data: ActivityPanelData | null;
  status: ActivityPanelStatus;
  error: string | null;
  /** Trigger a re-fetch of `/api/agent-activity`. No-op when inert. */
  reload: () => void;
  /**
   * Lazy-fetch the unified-diff text for a single burst.
   * Returns the cached diff when available. Re-fetches on cache miss.
   * Throws on network / server failure — callers surface the error in the
   * burst row's expanded state.
   */
  fetchBurstDiff: (docName: string, stackIndex: number) => Promise<string>;
}

const REFETCH_DEBOUNCE_MS = 500;

/**
 * Cap the burst-diff cache so long-lived agent sessions (many bursts × many
 * files) don't grow renderer memory unboundedly. Sized to match the
 * `ProviderPool` precedent (`MAX_POOL = 10`) × ~6 bursts typical for a mid-
 * sized file = 60; rounded up. Beyond the cap, LRU eviction drops the
 * least-recently-fetched entry. Cache keys are `${docName}\0${stackIndex}`.
 */
const BURST_DIFF_CACHE_LIMIT = 64;

// ---------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------

async function fetchAgentActivity(connectionId: string): Promise<{
  sessionAlive: boolean;
  agent: ActivityAgentHeader | null;
  files: ActivityFile[];
}> {
  const url = `/api/agent-activity?agentId=${encodeURIComponent(connectionId)}`;
  const res = await fetch(url);
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new HttpResponseParseError('Could not parse /api/agent-activity response.', {
      cause: err,
      status: res.status,
    });
  }
  if (!res.ok) {
    const problem = ProblemDetailsSchema.safeParse(body);
    if (!problem.success) {
      throw new HttpResponseParseError(
        '/api/agent-activity returned a non-RFC-9457 error response.',
        { cause: problem.error, status: res.status },
      );
    }
    throw new Error(problem.data.title);
  }
  const success = AgentActivitySuccessSchema.safeParse(body);
  if (!success.success) {
    throw new HttpResponseParseError(
      '/api/agent-activity returned a body that did not match AgentActivitySuccessSchema.',
      { cause: success.error, status: res.status },
    );
  }
  return success.data;
}

async function fetchBurstDiffHttp(
  connectionId: string,
  docName: string,
  stackIndex: number,
): Promise<string> {
  const url = `/api/agent-burst-diff?agentId=${encodeURIComponent(
    connectionId,
  )}&docName=${encodeURIComponent(docName)}&stackIndex=${stackIndex}`;
  const res = await fetch(url);
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new HttpResponseParseError('Could not parse /api/agent-burst-diff response.', {
      cause: err,
      status: res.status,
    });
  }
  if (!res.ok) {
    const problem = ProblemDetailsSchema.safeParse(body);
    if (!problem.success) {
      throw new HttpResponseParseError(
        '/api/agent-burst-diff returned a non-RFC-9457 error response.',
        { cause: problem.error, status: res.status },
      );
    }
    throw new Error(problem.data.title);
  }
  const success = AgentBurstDiffSuccessSchema.safeParse(body);
  if (!success.success) {
    throw new HttpResponseParseError(
      '/api/agent-burst-diff returned a body that did not match AgentBurstDiffSuccessSchema.',
      { cause: success.error, status: res.status },
    );
  }
  return success.data.diff;
}

// ---------------------------------------------------------------
// Hook
// ---------------------------------------------------------------

export function useActivityPanel(connectionId: string | null): UseActivityPanelResult {
  const { systemProvider } = useDocumentContext();
  const [data, setData] = useState<ActivityPanelData | null>(null);
  const [status, setStatus] = useState<ActivityPanelStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Burst-diff cache — keyed by `${docName}\0${stackIndex}`. LRU-bounded at
  // BURST_DIFF_CACHE_LIMIT so long-lived agent sessions can't exhaust
  // renderer memory. Cleared when connectionId changes so stale entries
  // from the previous agent's session can never leak into the new view.
  const diffCacheRef = useRef<LruStringCache>(new LruStringCache(BURST_DIFF_CACHE_LIMIT));

  // Token ref: each reload() call bumps this. Inflight responses compare
  // against the current token; mismatched = stale = discarded. Survives
  // component-re-render cycles without resetting.
  const tokenRef = useRef(0);

  // Trigger a re-fetch — used by reload() + CC1 debounced callback.
  const doFetch = (cid: string): void => {
    const token = ++tokenRef.current;
    setStatus('loading');
    setError(null);
    fetchAgentActivity(cid)
      .then((result) => {
        if (tokenRef.current !== token) return; // stale
        // Compute writingDocs from current systemProvider awareness (if any).
        const writingDocs = computeWritingDocs(systemProvider, cid);
        setData({ ...result, writingDocs });
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (tokenRef.current !== token) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });
  };

  // (1) + (2) On connectionId set: initial fetch + CC1 debounced subscription.
  // biome-ignore lint/correctness/useExhaustiveDependencies: systemProvider captured via closure; writingDocs recomputes on its own effect below.
  useEffect(() => {
    if (!connectionId) {
      tokenRef.current++;
      setData(null);
      setStatus('idle');
      setError(null);
      diffCacheRef.current.clear();
      return;
    }
    diffCacheRef.current.clear();
    doFetch(connectionId);

    // CC1: re-fetch on session-activity signal (debounced).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeToDocumentsChanged((channels) => {
      if (!channels.includes('session-activity')) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        doFetch(connectionId);
      }, REFETCH_DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [connectionId]);

  // (3) Subscribe to systemProvider awareness updates → refresh writingDocs.
  // Doesn't re-fetch the full activity list; just updates the `writingDocs`
  // field on the existing `data`. A ~1s backup interval handles stale-entry
  // aging in case awareness events stop firing.
  useEffect(() => {
    if (!connectionId) return;
    if (!systemProvider) return;

    const update = (): void => {
      // biome-ignore lint/suspicious/noExplicitAny: Awareness typing differs across Hocuspocus versions.
      const awareness = (systemProvider as { awareness?: unknown }).awareness as any;
      if (!awareness) return;
      const writing = computeWritingDocs(systemProvider, connectionId);
      setData((prev) => {
        if (!prev) return prev;
        if (setsEqual(prev.writingDocs, writing)) return prev;
        return { ...prev, writingDocs: writing };
      });
    };

    // biome-ignore lint/suspicious/noExplicitAny: Awareness typing differs across Hocuspocus versions.
    const awareness = (systemProvider as { awareness?: unknown }).awareness as any;
    if (!awareness || typeof awareness.on !== 'function') {
      update();
      return;
    }
    awareness.on('update', update);
    update();
    const interval = setInterval(update, 1000);
    return () => {
      clearInterval(interval);
      if (typeof awareness.off === 'function') awareness.off('update', update);
    };
  }, [connectionId, systemProvider]);

  // (4) Lazy burst-diff fetch with cache.
  const fetchBurstDiff = async (docName: string, stackIndex: number): Promise<string> => {
    if (!connectionId) return '';
    const key = `${docName}\0${stackIndex}`;
    const cached = diffCacheRef.current.get(key);
    if (cached !== undefined) return cached;
    const diff = await fetchBurstDiffHttp(connectionId, docName, stackIndex);
    diffCacheRef.current.set(key, diff);
    return diff;
  };

  const reload = (): void => {
    if (!connectionId) return;
    doFetch(connectionId);
  };

  return { data, status, error, reload, fetchBurstDiff };
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

/**
 * Compute the set of doc names the given agent is currently writing to, by
 * reading the `agentPresence` map off the `__system__` provider's awareness.
 * Accepts either the prefixed broadcaster-key form (`agent-<raw>`) or the
 * raw connectionId — tries both against the map so callers don't need to
 * know which form the presence map stores.
 *
 * Exported so unit tests can verify the prefix-normalization + filter logic
 * without rendering a React tree.
 */
export function computeWritingDocs(
  systemProvider: { awareness?: unknown } | null,
  connectionId: string,
): Set<string> {
  const out = new Set<string>();
  if (!systemProvider) return out;
  const awareness = systemProvider.awareness;
  if (!hasAgentPresenceShape(awareness)) return out;
  // Strip the `agent-` broadcaster-key prefix — presence map keys are the raw
  // agentId (see `toBroadcasterKey` in server/src/boot.ts). connectionId
  // coming from the API is the prefixed form in some paths; accept either.
  const candidateIds = [
    connectionId,
    connectionId.startsWith('agent-')
      ? connectionId.slice('agent-'.length)
      : `agent-${connectionId}`,
  ];
  for (const state of awareness.getStates().values()) {
    const presence = state.agentPresence;
    if (!presence) continue;
    for (const agentKey of candidateIds) {
      const entry = presence[agentKey];
      if (!entry) continue;
      if (entry.mode === 'writing' && entry.currentDoc) {
        out.add(entry.currentDoc);
      }
    }
  }
  return out;
}
