import { isInAppAgentEnabled } from '@/lib/acp/agent-visibility';
import { useEnabledOverrides } from '@/lib/acp/enabled-agents';
import {
  pickEffectiveDefaultAgent,
  type RegisteredAgent,
  registerAgent,
  useDefaultRegisteredAgent,
  useRegisteredAgents,
} from '@/lib/acp/registered-agents';
import { IN_APP_THREAD_ID, saveStickyAgent } from '@/lib/unified-agent-store';

export interface CommentAgentPicker {
  threadAgent: RegisteredAgent | null;
  rows: {
    threadAgents: readonly {
      key: string;
      id: string;
      name: string;
      iconUrl?: string;
      selected: boolean;
      onSelect: () => void;
    }[];
  };
}

export function useCommentAgentPicker(): CommentAgentPicker {
  const overrides = useEnabledOverrides();
  const registeredAgents = useRegisteredAgents();
  const defaultRegisteredAgent = useDefaultRegisteredAgent();
  const enabledThreadAgents = registeredAgents.filter((agent) =>
    isInAppAgentEnabled(overrides, agent.source, agent.id, true, agent.supported),
  );
  const threadAgent = pickEffectiveDefaultAgent(enabledThreadAgents, defaultRegisteredAgent);

  return {
    threadAgent,
    rows: {
      threadAgents: enabledThreadAgents.map((agent) => ({
        key: `${agent.source}:${agent.id}`,
        id: agent.id,
        name: agent.name,
        ...(agent.iconUrl !== undefined ? { iconUrl: agent.iconUrl } : {}),
        selected:
          threadAgent !== null &&
          threadAgent.source === agent.source &&
          threadAgent.id === agent.id,
        onSelect: () => {
          registerAgent(agent);
          saveStickyAgent(IN_APP_THREAD_ID);
        },
      })),
    },
  };
}
