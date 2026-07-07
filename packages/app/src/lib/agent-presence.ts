/**
 * Client-side helpers for observing agent presence on `__system__` awareness.
 *
 * The server publishes a map-valued `agentPresence?: Record<agentId, entry>`
 * field on its local awareness state (see `AgentPresenceBroadcaster` on the
 * server). Clients walk every awareness peer (the `__system__` DirectConnection
 * is the only producer in production — walking is defensive against test
 * injections and future producers), collect map entries, filter stale ones
 * + entries with `currentDoc === null`, and expose helpers for the
 * presence bar's sectioned layout + the nav consumer.
 */
import type { AgentPresenceEntry } from '@inkeep/open-knowledge-core';

/** Awareness entries older than this are filtered out. */
export const AGENT_PRESENCE_STALE_MS = 5_000;

/**
 * Minimal Yjs awareness shape needed by the helpers — keeps them testable
 * without importing the full `y-protocols/awareness` module.
 */
export interface AgentPresenceAwareness {
  getStates(): ReadonlyMap<number, AgentPresenceState>;
}

/**
 * Narrow runtime structural check — defends the cast from
 * `HocuspocusProvider.awareness` (typed as `y-protocols/awareness#Awareness`)
 * to our minimal `AgentPresenceAwareness` contract. Mirrors the server-side
 * `getAwareness(doc)` defensive pattern in `agent-presence.ts` so both sides
 * of the map-valued-awareness substrate fail loud (log + empty-read) rather
 * than throwing a runtime `TypeError` from `.getStates().values()` deep in a
 * render path.
 *
 * Stakes: `participantsEqual` deliberately skips presence comparisons that
 * don't affect render output, so a silent shape shift (Hocuspocus upgrade,
 * test mock swap, etc.) would manifest as "the bar goes empty, no warning"
 * — hard to diagnose. The guard converts that into a one-shot `[agent-
 * presence]` warning + empty-presence read.
 */
export function hasAgentPresenceShape(awareness: unknown): awareness is AgentPresenceAwareness {
  return (
    typeof awareness === 'object' &&
    awareness !== null &&
    typeof (awareness as { getStates?: unknown }).getStates === 'function'
  );
}

export interface AgentPresenceState {
  agentPresence?: Record<string, AgentPresenceEntry>;
}

/**
 * One presence entry paired with its `agentId` key. Consumers want both —
 * React needs a stable list key (`agentId`), the UI renders from the entry.
 * Returning the pair here means the caller does not need a second O(M·N)
 * reverse lookup on the awareness map to recover the id.
 */
interface AgentPresenceRecord {
  agentId: string;
  entry: AgentPresenceEntry;
}

/**
 * Aggregate and filter agent presence entries into two buckets: agents
 * currently on the active doc vs agents elsewhere (cross-doc). Stale entries
 * (`now - ts >= AGENT_PRESENCE_STALE_MS`) and entries with
 * `currentDoc === null` are dropped before bucketing.
 *
 * Returns `{agentId, entry}` pairs (not bare entries) so React consumers
 * have a stable list key without a second reverse-lookup pass. One peer walk
 * visits each awareness state once — no quadratic scan.
 *
 * Sectioned presence bar shape:
 *   `[...humans, ...current] | [divider] | [...crossDoc]`
 * where `current` agents get mode-based visual treatment and `crossDoc`
 * agents are dimmed + grayscaled.
 */
export function pickAgentsForDoc(
  awareness: AgentPresenceAwareness,
  activeDocName: string | null,
  now: number,
): { current: AgentPresenceRecord[]; crossDoc: AgentPresenceRecord[] } {
  const current: AgentPresenceRecord[] = [];
  const crossDoc: AgentPresenceRecord[] = [];
  for (const state of awareness.getStates().values()) {
    const presence = state.agentPresence;
    if (!presence) continue;
    for (const [agentId, entry] of Object.entries(presence)) {
      if (!entry.currentDoc) continue;
      if (now - entry.ts >= AGENT_PRESENCE_STALE_MS) continue;
      if (entry.currentDoc === activeDocName) {
        current.push({ agentId, entry });
      } else {
        crossDoc.push({ agentId, entry });
      }
    }
  }
  return { current, crossDoc };
}
