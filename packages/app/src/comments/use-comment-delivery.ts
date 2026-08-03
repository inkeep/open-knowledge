/**
 * Installs the store's delivery seam: how a queued comment actually reaches an
 * agent.
 *
 * Delivery reuses the SAME plumbing and the SAME target set as the "Ask AI"
 * composer — an in-app agent thread, the docked terminal, or a deep link into
 * an external app — because commenting and asking are meant to be one muscle
 * memory. It also means the passage is fitted to each target's transport and
 * budget by `buildComposerHandoffInput` (a deep link has a URL length limit),
 * which is why the server hands over ingredients rather than a finished prompt.
 *
 * Mount once where the queue lives; it registers on mount and clears on unmount.
 */

import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { useTerminalLaunch } from '@/components/handoff/TerminalLaunchContext';
import {
  buildComposerHandoffInput,
  openInstallUrl,
  startAgentThreadForInput,
  useHandoffDispatch,
} from '@/components/handoff/useHandoffDispatch';
import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
import { isInAppAgentEnabled } from '@/lib/acp/agent-visibility';
import { useEnabledOverrides } from '@/lib/acp/enabled-agents';
import {
  enabledDesktopTargets,
  enabledTerminalClis,
  resolveLauncherSelection,
} from '@/lib/acp/launcher-selection';
import {
  pickEffectiveDefaultAgent,
  useDefaultRegisteredAgent,
  useRegisteredAgents,
} from '@/lib/acp/registered-agents';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { loadStickyAgent } from '@/lib/unified-agent-store';
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
  const { dispatch } = useHandoffDispatch();
  const terminalLaunch = useTerminalLaunch();
  const { states } = useInstalledAgents();
  const registeredAgents = useRegisteredAgents();
  const defaultRegisteredAgent = useDefaultRegisteredAgent();

  const enabledAgents = registeredAgents.filter((agent) =>
    isInAppAgentEnabled(overrides, agent.source, agent.id, true, agent.supported),
  );
  const defaultThreadAgent = pickEffectiveDefaultAgent(enabledAgents, defaultRegisteredAgent);

  // One selection decision, enablement-aware — the same resolver the Ask AI
  // composer, create composer, and sessions dock share, so a disabled agent
  // is never what a comment launches either.
  const selection = resolveLauncherSelection({
    sticky: loadStickyAgent(),
    effectiveThreadAgent: defaultThreadAgent,
    enabledClis:
      terminalLaunch !== null ? enabledTerminalClis(overrides, terminalLaunch.installedClis) : [],
    enabledDesktopTargets: enabledDesktopTargets(overrides),
    installedClis: terminalLaunch?.installedClis ?? {},
    terminalAvailable: terminalLaunch !== null,
    threadsAvailable: true,
    desktopSelectable: true,
  });

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

    // One in-app agent thread for the whole batch.
    if (selection.kind === 'thread') {
      startAgentThreadForInput(
        input,
        defaultThreadAgent !== null
          ? { agent: { source: defaultThreadAgent.source, id: defaultThreadAgent.id } }
          : undefined,
      );
      return true;
    }

    // Docked terminal: hand the composed prompt to the selected CLI.
    if (selection.kind === 'cli' && terminalLaunch !== null) {
      try {
        terminalLaunch.launchInTerminal(input, selection.cli);
        return true;
      } catch {
        toast.error(t`Couldn't open the terminal — the comments are still waiting to send.`);
        return false;
      }
    }

    // Nothing enabled to ask with. Send the user where they can enable
    // something — the same destination the sessions dock picks in this state —
    // rather than swallowing a click that looked like a send.
    if (selection.kind === 'none') {
      toast.info(t`No agent is set up yet — opening Configure agents.`);
      openAgentSettings();
      return false;
    }
    // A CLI was selected but the terminal host is not mounted (web, or a build
    // without pty). Previously this fell through to a bare `return false`.
    if (selection.kind === 'cli') {
      toast.error(t`The terminal isn't available here — the comments are still waiting to send.`);
      return false;
    }
    if (selection.kind !== 'desktop') {
      toast.error(t`Couldn't work out where to send the comments — they're still waiting.`);
      return false;
    }
    const target = VISIBLE_TARGETS.find((entry) => entry.id === selection.target) ?? null;
    if (target === null) {
      toast.error(t`That app isn't available — the comments are still waiting to send.`);
      return false;
    }
    // Enabled but not installed: route to the installer rather than a
    // deep-link that would fail. Not a delivery, so the thread stays queued.
    if (states[target.id]?.installed !== true) {
      void openInstallUrl(target);
      toast.info(t`${target.displayName} isn't installed yet — opening its download page.`);
      return false;
    }
    const outcome = await dispatch(target.id, input);
    return outcome.ok;
  };
}
