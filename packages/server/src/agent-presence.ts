import type { Hocuspocus } from '@hocuspocus/server';
import { type AgentPresenceEntry, SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';
import { isPresenceEligibleAgentId } from './agent-id.ts';
import { getLogger } from './logger.ts';
import { incrementAgentPresenceMutationError } from './metrics.ts';

export const BROADCASTER_EVICTION_MS = 5_000 * 4;

export class AgentPresenceBroadcaster {
  private readonly hocuspocus: Hocuspocus;
  private readonly log = getLogger('agent-presence');
  private warnedMissing = false;
  private destroyed = false;

  constructor(hocuspocus: Hocuspocus) {
    this.hocuspocus = hocuspocus;
  }

  setPresence(agentId: string, entry: AgentPresenceEntry): void {
    if (!isPresenceEligibleAgentId(agentId)) return;
    let evictedCount = 0;
    const mutated = this.mutateAgentPresence((current) => {
      const now = Date.now();
      const next: Record<string, AgentPresenceEntry> = {};
      for (const [id, e] of Object.entries(current)) {
        if (now - e.ts >= BROADCASTER_EVICTION_MS && id !== agentId) {
          evictedCount++;
          continue;
        }
        next[id] = e;
      }
      next[agentId] = entry;
      return next;
    });
    if (mutated) {
      this.log.debug(
        { agentId, action: 'set', currentDoc: entry.currentDoc, ts: entry.ts },
        '[agent-presence] set',
      );
      if (evictedCount > 0) {
        this.log.info(
          { evictedCount, thresholdMs: BROADCASTER_EVICTION_MS },
          '[agent-presence] evicted stale entries',
        );
      }
    }
  }

  clearPresence(agentId: string): void {
    if (!isPresenceEligibleAgentId(agentId)) return;
    let removed = false;
    const mutated = this.mutateAgentPresence((current) => {
      const existing = current[agentId];
      if (!existing) return current;
      removed = true;
      const { [agentId]: _dropped, ...rest } = current;
      return rest;
    });
    if (mutated && removed) {
      this.log.info(
        { agentId, action: 'clear', currentDoc: null, ts: Date.now() },
        '[agent-presence] clear',
      );
    }
  }

  touchMode(agentId: string, mode: AgentPresenceEntry['mode']): void {
    if (!isPresenceEligibleAgentId(agentId)) return;
    const touched: { currentDoc: string | null; ts: number }[] = [];
    let existed = false;
    const mutated = this.mutateAgentPresence((current) => {
      const existing = current[agentId];
      if (!existing) return current;
      existed = true;
      const ts = Date.now();
      touched.push({ currentDoc: existing.currentDoc, ts });
      return { ...current, [agentId]: { ...existing, mode, ts } };
    });
    const record = touched[0];
    if (mutated && record) {
      this.log.debug(
        { agentId, action: 'touchMode', currentDoc: record.currentDoc, ts: record.ts, mode },
        '[agent-presence] touchMode',
      );
    } else if (!existed) {
      this.log.debug(
        { agentId, action: 'touchMode', mode, reason: 'entry-missing' },
        '[agent-presence] touchMode skipped — no entry for agentId',
      );
    }
  }

  bumpPresenceTs(agentId: string): void {
    if (!isPresenceEligibleAgentId(agentId)) return;
    let touchedTs: number | null = null;
    this.mutateAgentPresence((current) => {
      const existing = current[agentId];
      if (!existing) return current;
      const ts = Date.now();
      touchedTs = ts;
      return { ...current, [agentId]: { ...existing, ts } };
    });
    if (touchedTs !== null) {
      this.log.debug({ agentId, action: 'bumpTs', ts: touchedTs }, '[agent-presence] bumpTs');
    }
  }

  getPresenceMap(): Record<string, AgentPresenceEntry> {
    const awareness = this.resolveAwareness();
    if (!awareness) return {};
    const state = awareness.getLocalState() as {
      agentPresence?: Record<string, AgentPresenceEntry>;
    };
    return state?.agentPresence ?? {};
  }

  destroy(): void {
    this.destroyed = true;
  }

  private mutateAgentPresence(
    update: (current: Record<string, AgentPresenceEntry>) => Record<string, AgentPresenceEntry>,
  ): boolean {
    if (this.destroyed) return false;
    const awareness = this.resolveAwareness();
    if (!awareness) return false;
    try {
      const existing = (awareness.getLocalState() ?? {}) as {
        agentPresence?: Record<string, AgentPresenceEntry>;
      };
      const current = existing.agentPresence ?? {};
      const nextPresence = update(current);
      awareness.setLocalState({ ...existing, agentPresence: nextPresence });
      return true;
    } catch (err) {
      incrementAgentPresenceMutationError();
      this.log.error({ err }, '[agent-presence] awareness mutation failed');
      return false;
    }
  }

  private resolveAwareness(): DocumentWithAwareness['awareness'] | null {
    const doc = this.hocuspocus.documents.get(SYSTEM_DOC_NAME);
    if (!doc) {
      if (!this.warnedMissing) {
        this.log.warn(
          {},
          '[agent-presence] __system__ document not found — presence updates will be dropped until it is materialized',
        );
        this.warnedMissing = true;
      }
      return null;
    }
    if (this.warnedMissing) {
      this.log.info(
        {},
        '[agent-presence] __system__ document now available — resuming presence updates',
      );
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
