/**
 * `AgentPresenceBroadcaster` — publishes per-agent presence state on the
 * `__system__` Y.Doc's awareness so every connected client can render a
 * correct multi-agent presence bar.
 *
 * Why it lives here:
 *   - Every Hocuspocus `Document` has one shared server-side `Awareness` with
 *     a single `clientID`; per-content-doc agent state therefore stomps across
 *     N concurrent agents. Publishing a map-valued `agentPresence` field on
 *     `__system__` — keyed by `agentId` — sidesteps that constraint.
 *   - Reuses the existing server-wide `__system__` DirectConnection (opened
 *     by the CC1 broadcaster). Does NOT open its own DirectConnection and
 *     does NOT bypass the `isSystemDoc` guard in `AgentSessionManager`.
 *
 * The same `__system__` Y.Doc also carries CC1 pure-signal broadcasts
 * (`cc1-broadcast.ts`). The two concerns use structurally-distinct channels
 * (awareness state vs `broadcastStateless`) so they do not collide; the
 * `isSystemDoc()` short-circuit in every subsystem that keys off
 * `documentName` still applies to both.
 *
 * API shape:
 *   - `setPresence(agentId, entry)` — upsert. Merges into the existing map;
 *     other agents' entries are preserved. Opportunistically evicts entries
 *     older than 4× TTL to bound map growth when clients disconnect without
 *     a clean close (proxy ate the close frame, process killed -9, etc.).
 *   - `clearPresence(agentId)` — remove exactly one entry. No-op if missing.
 *   - `touchMode(agentId, mode)` — update just the mode + ts of an existing
 *     entry. Graceful no-op when the agent has no existing entry (never
 *     creates a half-populated entry missing displayName/icon/color).
 *   - `getPresenceMap()` — diagnostic read.
 *   - `destroy()` — sets a guard flag so post-destroy calls are no-ops
 *     (parity with `CC1Broadcaster.destroy()`; called during server shutdown).
 */
import type { Hocuspocus } from '@hocuspocus/server';
import { type AgentPresenceEntry, SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';
import { isPresenceEligibleAgentId } from './agent-id.ts';
import { getLogger } from './logger.ts';
import { incrementAgentPresenceMutationError } from './metrics.ts';

/**
 * Server-side eviction threshold. Runs opportunistically during setPresence
 * to drop entries far beyond the client-side 5s TTL filter. Generous by
 * design — the keepalive WS close is the primary signal; eviction is a
 * belt-and-suspenders defense against unbounded growth when the close never
 * fires (proxy drops the frame, process killed -9, network partition).
 *
 * 4× the client TTL (5_000ms × 4 = 20_000ms): any entry that far stale is
 * effectively invisible to clients already; dropping it from the server
 * map shrinks awareness fan-out size without user-visible change.
 */
export const BROADCASTER_EVICTION_MS = 5_000 * 4;

export class AgentPresenceBroadcaster {
  private readonly hocuspocus: Hocuspocus;
  private readonly log = getLogger('agent-presence');
  private warnedMissing = false;
  private destroyed = false;

  constructor(hocuspocus: Hocuspocus) {
    this.hocuspocus = hocuspocus;
  }

  /**
   * Upsert an agent's presence entry. Other agents' entries are preserved.
   * Opportunistically evicts entries older than BROADCASTER_EVICTION_MS to
   * bound map growth under ungraceful disconnects.
   */
  setPresence(agentId: string, entry: AgentPresenceEntry): void {
    if (!isPresenceEligibleAgentId(agentId)) return;
    let evictedCount = 0;
    const mutated = this.mutateAgentPresence((current) => {
      // Amortized eviction: scan once per setPresence. Cost is O(N) where N
      // is the live agent count — bounded by the same map we're writing.
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

  /**
   * Remove an agent's entry. No-op if the entry doesn't exist.
   *
   * Reconnect-race defense lives at the CALLER (boot.ts keepalive close
   * handler), NOT here. The broadcaster has no way to distinguish "the
   * owning WS is closing normally" from "an old WS's close fired late after
   * a successor took over" by looking at the entry alone — `entry.ts` is
   * updated on every write regardless of which WS the write came through,
   * so a ts-based gate would incorrectly skip every normal cleanup (every
   * real agent writes via HTTP AFTER its keepalive WS opens → entry.ts is
   * always newer than openedAt). boot.ts tracks the current owning WS per
   * agent via a latest-opener map and skips the clear call when a newer WS
   * has taken over; this method fires unconditionally when called.
   */
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
      // INFO because this is the deterministic-cleanup signal; operators
      // read it to confirm keepalive-close routing is wired.
      this.log.info(
        { agentId, action: 'clear', currentDoc: null, ts: Date.now() },
        '[agent-presence] clear',
      );
    }
  }

  /**
   * Update the mode + ts of an existing presence entry. Graceful no-op when
   * the agent has no existing entry — we must NEVER write a half-populated
   * entry because clients filter by `currentDoc === null` but do not defend
   * against missing displayName/icon/color. Logs at DEBUG when the no-op
   * fires so "why is the badge stuck?" has a diagnostic breadcrumb.
   */
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
      // Diagnostic breadcrumb: a touchMode call with no matching entry means
      // either (a) the agent's entry was cleared between setPresence and
      // this call (keepalive close fired mid-write) or (b) a future call
      // site invoked touchMode without a prior setPresence.
      this.log.debug(
        { agentId, action: 'touchMode', mode, reason: 'entry-missing' },
        '[agent-presence] touchMode skipped — no entry for agentId',
      );
    }
  }

  /**
   * Bump just the `ts` of an existing entry to `Date.now()`. Graceful no-op
   * when there's no entry for the agent. Same half-populated-entry invariant
   * as `touchMode` — never writes if the agent hasn't called `setPresence`.
   *
   * Motivation: the client-side TTL filter (`AGENT_PRESENCE_STALE_MS` = 5s)
   * hides entries that haven't been touched recently. Write-path calls
   * (`setPresence`/`touchMode`) only fire on MCP edits; an agent between
   * tool calls (LLM thinking for 10-30s) doesn't emit them, so the client
   * would drop its badge mid-session even though its keepalive WS is still
   * open and the agent is still alive.
   *
   * `bumpPresenceTs` is the server-side signal that says "this agent is
   * still connected — keep it visible." boot.ts's keepalive-upgrade handler
   * calls this on a 3s timer for every WS with an `agentId`, which
   * consistently beats the 5s TTL. The client filter then catches only
   * genuinely dead keepalives (proxy ate the close frame, etc.) instead of
   * spuriously hiding live agents.
   *
   * Logged at DEBUG only (called at ~3s cadence per connected agent —
   * INFO-level would flood operator logs). `mode` is preserved so an
   * agent whose last state was `'writing'` continues to show the pulse
   * visual client-side until its own `touchMode('idle')` arrives.
   */
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

  /** Read the current map (diagnostics + tests). */
  getPresenceMap(): Record<string, AgentPresenceEntry> {
    const awareness = this.resolveAwareness();
    if (!awareness) return {};
    const state = awareness.getLocalState() as {
      agentPresence?: Record<string, AgentPresenceEntry>;
    };
    return state?.agentPresence ?? {};
  }

  /**
   * No timers today; sets a guard flag so post-destroy
   * setPresence/clearPresence/touchMode calls are no-ops. Parity with
   * `CC1Broadcaster.destroy()` for shutdown-ordering symmetry.
   */
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
      // y-protocols awareness.setLocalStateField is a no-op when local state is
      // null (its source reads `getLocalState()` and guards `if (state !== null)`).
      // The server-side Document's awareness starts null, so we always go
      // through setLocalState with an explicit merge — bootstraps state on
      // the first call and preserves any non-agentPresence fields other
      // subsystems may set.
      const existing = (awareness.getLocalState() ?? {}) as {
        agentPresence?: Record<string, AgentPresenceEntry>;
      };
      const current = existing.agentPresence ?? {};
      const nextPresence = update(current);
      awareness.setLocalState({ ...existing, agentPresence: nextPresence });
      return true;
    } catch (err) {
      // Counter + structured log: every caller (HTTP handlers, keepalive
      // close) ignores our `false` return, so without the counter a silent
      // awareness failure has only a pino ERROR line nobody is alerting on.
      // The counter surfaces via GET /api/metrics/reconciliation.
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
    // Recovery signal: log once when __system__ becomes available after a
    // miss so operators can confirm the broadcaster resumed.
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
