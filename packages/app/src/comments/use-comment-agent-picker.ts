/**
 * Agent picker for the Comments panel's Send control.
 *
 * In-app agents ONLY. The other pickers in the app also offer Desktop apps and
 * docked-terminal CLIs, because those surfaces can send there; a comment batch
 * always starts an in-app thread (see `use-comment-delivery`), so listing a CLI
 * here would offer a destination this panel never uses — and picking one would
 * quietly repoint the Ask AI composer through the shared sticky store while
 * changing nothing about where comments go.
 *
 * Picking an agent still writes through `registerAgent` + `saveStickyAgent`, so
 * "which agent" stays one answer across surfaces. Only "which KIND of surface"
 * is fixed here.
 */

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
  /** The in-app agent a send would launch, or null when none is enabled. */
  threadAgent: RegisteredAgent | null;
  /** Props to spread onto `AgentSplitButton`. */
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
          // Picking a specific agent re-registers it as the default a send
          // launches, then selects thread mode so the shared sticky store does
          // not leave another surface pointed at a CLI on this agent's behalf.
          // No local mirror of the pick: the tick reads `threadAgent`, and
          // `registerAgent` re-renders this hook through
          // `useDefaultRegisteredAgent`. A copy in state would only force the
          // render it is already getting, and could disagree with the registry
          // in the window before it did.
          registerAgent(agent);
          saveStickyAgent(IN_APP_THREAD_ID);
        },
      })),
    },
  };
}
