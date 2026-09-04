import type { AgentPresenceEntry } from '@inkeep/open-knowledge-core';

export const AGENT_PRESENCE_STALE_MS = 5_000;

export interface AgentPresenceAwareness {
  getStates(): ReadonlyMap<number, AgentPresenceState>;
}

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

interface AgentPresenceRecord {
  agentId: string;
  entry: AgentPresenceEntry;
}

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
