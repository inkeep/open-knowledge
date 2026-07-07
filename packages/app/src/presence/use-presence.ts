import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { AgentPresenceEntry } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import {
  type AgentPresenceAwareness,
  hasAgentPresenceShape,
  pickAgentsForDoc,
} from '@/lib/agent-presence';
import type { AwarenessUser } from './identity.ts';
import {
  type AgentParticipant,
  dedupeHumansByPrincipalId,
  type HumanParticipant,
  type Participant,
  participantsEqual,
} from './participant-model.ts';

// `pickAgentsForDoc` returns `{agentId, entry}` pairs directly so this hook
// doesn't have to reverse-lookup the id from the awareness map per render.
// The earlier shape forced a Map.entries() reverse lookup inside the
// participants build, which was O(N²) over presence-map size.

export type { AgentParticipant, HumanParticipant, Participant } from './participant-model.ts';

/**
 * 1s cadence is a compromise. Awareness-change events fan out on every
 * server-side `setPresence` / `touchMode` / `clearPresence` — that's the
 * primary signal. The interval tick exists as a backup so TTL-based
 * staleness (silent WS close / clock skew) ages entries out even
 * when no awareness-change fires. Not user-visible; small enough to catch
 * a 5s-stale entry within ~1s of its real expiry, big enough to keep the
 * re-render cost negligible.
 */
const TTL_TICK_MS = 1_000;

/**
 * Process-wide one-shot guard for the shape-guard warning. The hook remounts
 * on every provider swap, but a shape mismatch comes from the provider
 * class / Hocuspocus upgrade — it's a static trait of the build, not a
 * per-mount concern. Warning once per process surfaces the drift without
 * spamming on every remount.
 */
let warnedOnMalformedAwareness = false;

/**
 * Discriminator for "this awareness entry is the local user themselves" —
 * `principalId` when a git-resolved identity exists, Yjs `clientID` when the
 * identity is synthesized (no git config). The principalId branch filters
 * multi-tab self across tabs; the clientID branch only filters the current
 * tab (a synthesized user opening two tabs sees the other tab as another
 * viewer — accepted edge for synthesized identities).
 *
 * `localPrincipalId === null` collapses to clientID-only matching, which is
 * also the safe transient when `getLocalState()` hasn't resolved yet — the
 * first render simply doesn't filter.
 */
export function isSelfAwarenessEntry(args: {
  readonly entryPrincipalId: string | undefined;
  readonly entryClientId: number;
  readonly localPrincipalId: string | null;
  readonly localClientId: number | null;
}): boolean {
  if (args.localPrincipalId && args.entryPrincipalId === args.localPrincipalId) return true;
  if (!args.localPrincipalId && args.entryClientId === args.localClientId) return true;
  return false;
}

/**
 * Two-source presence reader for the sectioned PresenceBar.
 *
 * Humans come from the **per-doc** `activeProvider.awareness` (each human
 * has their own Y.Doc clientID; cursor positions + name/color live here).
 * Agents come from the **`__system__`-scoped** `systemProvider.awareness`
 * map-valued field `agentPresence`, bucketed into `current` (same-doc as
 * `activeDocName`) vs `crossDoc` (different doc).
 *
 * Returns two arrays:
 *   - `current`: humans + agents whose `currentDoc === activeDocName`
 *   - `crossDoc`: agents whose `currentDoc !== activeDocName` (and non-null)
 *
 * Ordering: humans first in `current` (they're the active user's peers on
 * this doc), then same-doc agents. Within each group, stable insertion
 * order (awareness state map iteration order).
 */
export function usePresence(
  activeProvider: HocuspocusProvider | null,
  systemProvider: HocuspocusProvider | null,
  activeDocName: string | null,
): { current: Participant[]; crossDoc: AgentParticipant[] } {
  // `crossDoc` is by construction `AgentParticipant[]` — only agents have a
  // `currentDoc` field that can differ from `activeDocName`. Humans are
  // always tied to the doc they're viewing (per-doc awareness), so they can
  // never appear in crossDoc. Narrowing the return type documents the design
  // and prevents dead branches in callers that check `kind === 'human'`.
  const [state, setState] = useState<{ current: Participant[]; crossDoc: AgentParticipant[] }>({
    current: [],
    crossDoc: [],
  });

  useEffect(() => {
    const activeAwareness = activeProvider?.awareness;
    // Structural guard at the one boundary where the cast happens — the
    // only place `HocuspocusProvider.awareness`'s y-protocols shape meets
    // our narrow `AgentPresenceAwareness` contract. If Hocuspocus ever
    // ships a breaking upgrade or a test passes a mock that doesn't expose
    // `getStates()`, we log a one-shot warning (`[agent-presence]` matches
    // SystemDocSubscriber's convention) and read empty instead of crashing
    // deep in `.getStates().values()` during a render.
    const rawSystemAwareness: unknown = systemProvider?.awareness;
    let systemAwareness: AgentPresenceAwareness | undefined;
    if (rawSystemAwareness === undefined || rawSystemAwareness === null) {
      systemAwareness = undefined;
    } else if (hasAgentPresenceShape(rawSystemAwareness)) {
      systemAwareness = rawSystemAwareness;
    } else {
      systemAwareness = undefined;
      if (!warnedOnMalformedAwareness) {
        warnedOnMalformedAwareness = true;
        console.warn(
          '[agent-presence] __system__ provider awareness missing getStates() — presence bar will render without agent peers',
        );
      }
    }

    const compute = (): void => {
      // Capture the local discriminator once per pass — the per-tab user
      // must not appear in their own presence bar (Notion/Drive convention).
      // Filtered BEFORE `dedupeHumansByPrincipalId` so a multi-tab self
      // doesn't get collapsed and emitted as one "remote viewer".
      const localState = activeAwareness?.getLocalState() as { user?: AwarenessUser } | undefined;
      const localPrincipalId = localState?.user?.principalId ?? null;
      const localClientId = activeAwareness?.clientID ?? null;

      const humans: HumanParticipant[] = [];
      if (activeAwareness) {
        for (const [clientId, rawState] of activeAwareness.getStates().entries()) {
          const s = rawState as Record<string, unknown>;
          if (!s.user || typeof s.user !== 'object') continue;
          const user = s.user as AwarenessUser;
          // Defensive: AwarenessUser.type is narrowed to 'human' by the type
          // system but a stale bundled client could still emit 'agent'. Skip
          // that shape silently — no warning is wired here. SystemDocSubscriber's
          // per-clientID warn targets the `__system__` awareness surface; this
          // hook iterates the per-doc provider's awareness, a different surface,
          // so that warning path does not cover what this branch skips.
          if (user.type !== 'human') continue;
          if (
            isSelfAwarenessEntry({
              entryPrincipalId: user.principalId,
              entryClientId: clientId,
              localPrincipalId,
              localClientId,
            })
          ) {
            continue;
          }
          humans.push({
            kind: 'human',
            clientId,
            user,
            mode: (s.mode as HumanParticipant['mode']) ?? 'wysiwyg',
            tabCount: 1,
          });
        }
      }
      const deduped = dedupeHumansByPrincipalId(humans);

      const now = Date.now();
      const { current: currentAgents, crossDoc: crossDocAgents } = systemAwareness
        ? pickAgentsForDoc(systemAwareness, activeDocName, now)
        : { current: [], crossDoc: [] };

      const toParticipant = ({
        agentId,
        entry,
      }: {
        agentId: string;
        entry: AgentPresenceEntry;
      }): AgentParticipant => ({
        kind: 'agent',
        agentId,
        presence: entry,
      });
      const currentAgentParticipants: AgentParticipant[] = currentAgents.map(toParticipant);
      const crossDocAgentParticipants: AgentParticipant[] = crossDocAgents.map(toParticipant);

      const nextCurrent: Participant[] = [...deduped, ...currentAgentParticipants];
      const nextCrossDoc: AgentParticipant[] = crossDocAgentParticipants;
      // Functional updater so the equality check compares against the
      // LATEST committed state, not a stale closure capture. When both
      // arrays are participant-equal to what's already rendered, return
      // prev — React's useState bails out on `Object.is(prev, next)` and
      // skips the re-render. The 1 Hz TTL tick hits this fast path on
      // every idle second; only semantic changes (new peer, mode flip,
      // doc move, TTL expiry) commit state.
      setState((prev) => {
        if (
          participantsEqual(prev.current, nextCurrent) &&
          participantsEqual(prev.crossDoc, nextCrossDoc)
        ) {
          return prev;
        }
        return { current: nextCurrent, crossDoc: nextCrossDoc };
      });
    };

    compute();

    const handleActive = (): void => compute();
    const handleSystem = (): void => compute();
    activeAwareness?.on('change', handleActive);
    systemProvider?.awareness?.on('change', handleSystem);

    // TTL refresh — see TTL_TICK_MS for rationale.
    const interval = setInterval(compute, TTL_TICK_MS);

    return () => {
      activeAwareness?.off('change', handleActive);
      systemProvider?.awareness?.off('change', handleSystem);
      clearInterval(interval);
    };
  }, [activeProvider, systemProvider, activeDocName]);

  return state;
}
