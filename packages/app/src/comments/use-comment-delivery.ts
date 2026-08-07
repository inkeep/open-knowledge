/**
 * How a queued comment actually reaches an agent.
 *
 * A comment batch ALWAYS starts an in-app agent thread. It used to resolve the
 * same target set as the "Ask AI" composer — thread, docked terminal, or a deep
 * link into an external app — which meant a reviewer whose standing preference
 * was a CLI pressed Send in the Comments panel and landed in the terminal. A
 * batch of comments is a review conversation with somewhere to put replies; the
 * terminal is a different kind of place, and being sent there by a preference
 * set for another surface reads as the button misfiring.
 *
 * The passage is still fitted by `buildComposerHandoffInput`, which is why the
 * server hands over ingredients rather than a finished prompt.
 */

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

/**
 * The instruction handed to the agent. The comment body is the request; the
 * passage rides as the selection so the composer can transport it per target.
 *
 * When the anchor was lost we say so explicitly. Without that line an agent
 * that cannot find the passage may "fix" a different occurrence, or re-add text
 * a rewrite deliberately removed — the silent-wrong-target failure the whole
 * anchoring design exists to prevent.
 */
function composeInstruction(payloads: readonly DispatchPayload[]): string {
  return composeCommentBatchInstruction(payloads.map(toCommentBatchItem), '');
}

/**
 * The hand-off a comment batch takes to reach an agent — a fresh turn on the
 * user's preferred target.
 *
 * RETURNED rather than registered into the store. As an installed slot it was
 * only live while the Comments tab was mounted, so a send from anywhere else
 * silently did nothing; a caller that holds the function cannot have that
 * problem, and the store keeps no mutable global to reason about.
 */
export function useCommentDispatch(): ComposeDispatch {
  const workspace = useWorkspace();
  const overrides = useEnabledOverrides();
  const registeredAgents = useRegisteredAgents();
  const defaultRegisteredAgent = useDefaultRegisteredAgent();

  // WHICH in-app agent, never whether to use one. The picker beside the Send
  // button chooses among these; there is no CLI or desktop branch to resolve.
  const enabledAgents = registeredAgents.filter((agent) =>
    isInAppAgentEnabled(overrides, agent.source, agent.id, true, agent.supported),
  );
  const defaultThreadAgent = pickEffectiveDefaultAgent(enabledAgents, defaultRegisteredAgent);

  return async (items: readonly BatchPreparedItem[]) => {
    const payloads = items.map((item) => item.payload);
    if (payloads.length === 0) return false;
    // Project scope: a batch spans documents, so no single doc leads. Each
    // comment names its own file inside the composed instruction, and every
    // touched doc rides as a mention.
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

    // No in-app agent enabled: send the user where they can enable one rather
    // than swallowing a click that looked like a send. Returning false leaves
    // every thread queued, so nothing is marked done that nobody received.
    if (defaultThreadAgent === null) {
      toast.info(t`No agent is set up yet — opening Configure agents.`);
      openAgentSettings();
      return false;
    }

    // One in-app agent thread for the whole batch.
    startAgentThreadForInput(input, {
      agent: { source: defaultThreadAgent.source, id: defaultThreadAgent.id },
    });
    return true;
  };
}
