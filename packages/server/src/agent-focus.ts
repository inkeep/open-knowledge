/**
 * `AgentFocusBroadcaster` — publishes per-agent focus state on the `__system__`
 * Y.Doc's awareness so every connected client can follow the active agent.
 *
 * Transport:
 *   - Reuses the existing server-wide `__system__` DirectConnection owned by
 *     the CC1 broadcaster. Does NOT open its own DirectConnection and does NOT
 *     bypass the `isSystemDoc` guard in `AgentSessionManager`.
 *   - State is a map-valued awareness field keyed by `agentId`, so N concurrent
 *     agents coexist under the single shared `clientID` without stomping.
 *
 * Path A scope:
 *   - Path A callers pass the hardcoded `DEFAULT_AGENT_ID`; only one entry ever
 *     lives in the map. Path B will route distinct agent IDs per MCP
 *     session through `readAgentIdentity(req)` — the broadcaster API is already
 *     shaped for it (agentId is a first-class parameter).
 *   - `clearFocus(agentId)` exists for forward-compatibility. No Path A caller
 *     uses it today; Path B session-end logic will.
 */
import type { Hocuspocus } from '@hocuspocus/server';
import { type AgentFocusEntry, SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';
import { isPresenceEligibleAgentId } from './agent-id.ts';
import { getLogger } from './logger.ts';

export class AgentFocusBroadcaster {
  private readonly hocuspocus: Hocuspocus;
  private readonly log = getLogger('agent-focus');
  private warnedMissing = false;

  constructor(hocuspocus: Hocuspocus) {
    this.hocuspocus = hocuspocus;
  }

  /** Upsert an agent's focus entry. Merges into the existing map — other agents' entries are preserved. */
  setFocus(agentId: string, entry: AgentFocusEntry): void {
    if (!isPresenceEligibleAgentId(agentId)) return;
    this.mutateAgentFocus((current) => ({ ...current, [agentId]: entry }));
  }

  /** Remove an agent's entry. No-op if the entry doesn't exist. */
  clearFocus(agentId: string): void {
    if (!isPresenceEligibleAgentId(agentId)) return;
    this.mutateAgentFocus((current) => {
      if (!(agentId in current)) return current;
      const { [agentId]: _dropped, ...rest } = current;
      return rest;
    });
  }

  /** Read the current map (diagnostics + tests). */
  getFocusMap(): Record<string, AgentFocusEntry> {
    const awareness = this.resolveAwareness();
    if (!awareness) return {};
    const state = awareness.getLocalState() as { agentFocus?: Record<string, AgentFocusEntry> };
    return state?.agentFocus ?? {};
  }

  private mutateAgentFocus(
    update: (current: Record<string, AgentFocusEntry>) => Record<string, AgentFocusEntry>,
  ): void {
    const awareness = this.resolveAwareness();
    if (!awareness) return;
    try {
      // y-protocols awareness.setLocalStateField is a no-op when local state is
      // null (its source reads `getLocalState()` and guards `if (state !== null)`).
      // The server-side Document's awareness starts null, so we always go through
      // setLocalState with an explicit merge — this bootstraps state on the first
      // call and preserves any non-agentFocus fields other subsystems may set.
      const existing = (awareness.getLocalState() ?? {}) as {
        agentFocus?: Record<string, AgentFocusEntry>;
      };
      const current = existing.agentFocus ?? {};
      const nextFocus = update(current);
      awareness.setLocalState({ ...existing, agentFocus: nextFocus });
    } catch (err) {
      this.log.error({ err }, '[agent-focus] awareness mutation failed');
    }
  }

  private resolveAwareness(): ReturnType<typeof getAwareness> | null {
    const doc = this.hocuspocus.documents.get(SYSTEM_DOC_NAME);
    if (!doc) {
      if (!this.warnedMissing) {
        this.log.warn(
          {},
          '[agent-focus] __system__ document not found — focus updates will be dropped until it is materialized',
        );
        this.warnedMissing = true;
      }
      return null;
    }
    // Recovery signal: log once when __system__ becomes available after a miss
    // so operators can confirm the broadcaster resumed.
    if (this.warnedMissing) {
      this.log.info({}, '[agent-focus] __system__ document now available — resuming focus updates');
      this.warnedMissing = false;
    }
    return getAwareness(doc);
  }
}

type DocumentWithAwareness = {
  awareness: {
    getLocalState: () => Record<string, unknown> | null;
    setLocalState: (state: Record<string, unknown> | null) => void;
  };
};

function getAwareness(doc: unknown): DocumentWithAwareness['awareness'] | null {
  const awareness = (doc as DocumentWithAwareness | undefined)?.awareness;
  return awareness ?? null;
}
