import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import {
  buildComposerHandoffInput,
  startAgentThreadForInput,
} from '@/components/handoff/useHandoffDispatch';
import { isInAppAgentEnabled } from '@/lib/acp/agent-visibility';
import { useEnabledOverrides } from '@/lib/acp/enabled-agents';
import {
  pickEffectiveDefaultAgent,
  useDefaultRegisteredAgent,
  useRegisteredAgents,
} from '@/lib/acp/registered-agents';
import { openAgentSettings } from '@/lib/use-settings-route';
import { useWorkspace } from '@/lib/use-workspace';
import { docNameToRelativePath } from '@/lib/workspace-paths';
import { composeCommentBatchInstruction, toCommentBatchItem } from './comment-chips';
import type { DispatchPayload } from './comments-client';
import type { BatchPreparedItem, ComposeDispatch } from './store';

function composeInstruction(payloads: readonly DispatchPayload[]): string {
  return composeCommentBatchInstruction(payloads.map(toCommentBatchItem), '');
}

export function useCommentDispatch(): ComposeDispatch {
  const workspace = useWorkspace();
  const overrides = useEnabledOverrides();
  const registeredAgents = useRegisteredAgents();
  const defaultRegisteredAgent = useDefaultRegisteredAgent();

  const enabledAgents = registeredAgents.filter((agent) =>
    isInAppAgentEnabled(overrides, agent.source, agent.id, true, agent.supported),
  );
  const defaultThreadAgent = pickEffectiveDefaultAgent(enabledAgents, defaultRegisteredAgent);

  return async (items: readonly BatchPreparedItem[]) => {
    const payloads = items.map((item) => item.payload);
    if (payloads.length === 0) return false;
    const input = buildComposerHandoffInput({
      docName: null,
      workspace,
      instruction: composeInstruction(payloads),
      mentions: [...new Set(payloads.map((p) => docNameToRelativePath(p.docName)))],
    });
    if (input === null) {
      toast.error(t`Couldn't send your comments — the workspace isn't ready.`);
      return false;
    }

    if (defaultThreadAgent === null) {
      toast.info(t`No agent is set up yet — opening Configure agents.`);
      openAgentSettings();
      return false;
    }

    startAgentThreadForInput(input, {
      agent: { source: defaultThreadAgent.source, id: defaultThreadAgent.id },
    });
    return true;
  };
}
