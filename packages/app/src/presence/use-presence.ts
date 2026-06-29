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


export type { AgentParticipant, HumanParticipant, Participant } from './participant-model.ts';

const TTL_TICK_MS = 1_000;

let warnedOnMalformedAwareness = false;

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

export function usePresence(
  activeProvider: HocuspocusProvider | null,
  systemProvider: HocuspocusProvider | null,
  activeDocName: string | null,
): { current: Participant[]; crossDoc: AgentParticipant[] } {
  const [state, setState] = useState<{ current: Participant[]; crossDoc: AgentParticipant[] }>({
    current: [],
    crossDoc: [],
  });

  useEffect(() => {
    const activeAwareness = activeProvider?.awareness;
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
      const localState = activeAwareness?.getLocalState() as { user?: AwarenessUser } | undefined;
      const localPrincipalId = localState?.user?.principalId ?? null;
      const localClientId = activeAwareness?.clientID ?? null;

      const humans: HumanParticipant[] = [];
      if (activeAwareness) {
        for (const [clientId, rawState] of activeAwareness.getStates().entries()) {
          const s = rawState as Record<string, unknown>;
          if (!s.user || typeof s.user !== 'object') continue;
          const user = s.user as AwarenessUser;
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

    const interval = setInterval(compute, TTL_TICK_MS);

    return () => {
      activeAwareness?.off('change', handleActive);
      systemProvider?.awareness?.off('change', handleSystem);
      clearInterval(interval);
    };
  }, [activeProvider, systemProvider, activeDocName]);

  return state;
}
