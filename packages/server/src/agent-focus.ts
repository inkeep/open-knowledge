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

  setFocus(agentId: string, entry: AgentFocusEntry): void {
    if (!isPresenceEligibleAgentId(agentId)) return;
    this.mutateAgentFocus((current) => ({ ...current, [agentId]: entry }));
  }

  clearFocus(agentId: string): void {
    if (!isPresenceEligibleAgentId(agentId)) return;
    this.mutateAgentFocus((current) => {
      if (!(agentId in current)) return current;
      const { [agentId]: _dropped, ...rest } = current;
      return rest;
    });
  }

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
