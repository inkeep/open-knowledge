/**
 * Agent picker for the queue panel's Send control.
 *
 * Assembles the same row set the Ask-AI composer's picker shows — enabled
 * Desktop apps, docked-terminal CLIs, in-app agents — and resolves the current
 * target with the shared `resolveLauncherSelection`.
 *
 * KNOWN DUPLICATION: `BottomComposer`, `CreatePromptComposer`,
 * `TerminalSessionsHost`, and this file each assemble these rows independently.
 * They agree only by discipline, and the composer's own comment already warns
 * about the pickers drifting. Consolidating them into one shared hook is the
 * right fix; this copy was taken deliberately to keep the queue panel isolated
 * from those working surfaces, not because a fourth copy is correct.
 *
 * Picks write through `saveStickyAgent`, the same storage the composer reads,
 * so choosing an agent here changes where the composer sends too — the two
 * surfaces stay in agreement through the store rather than through shared code.
 */

import { type TargetData, TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { useState } from 'react';
import type { TerminalCliRow } from '@/components/handoff/AgentSplitButton';
import { useTerminalLaunch } from '@/components/handoff/TerminalLaunchContext';
import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
import { isDesktopTargetEnabled, isInAppAgentEnabled } from '@/lib/acp/agent-visibility';
import { useEnabledOverrides } from '@/lib/acp/enabled-agents';
import {
  enabledDesktopTargets,
  enabledTerminalClis,
  resolveLauncherSelection,
} from '@/lib/acp/launcher-selection';
import {
  pickEffectiveDefaultAgent,
  type RegisteredAgent,
  registerAgent,
  useDefaultRegisteredAgent,
  useRegisteredAgents,
} from '@/lib/acp/registered-agents';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import {
  IN_APP_THREAD_ID,
  loadStickyAgent,
  saveStickyAgent,
  terminalCliId,
} from '@/lib/unified-agent-store';

export interface CommentAgentPicker {
  /** In-app agent thread is the resolved target. */
  isThreadSelected: boolean;
  /** The in-app agent a send would launch, when `isThreadSelected`. */
  threadAgent: RegisteredAgent | null;
  /** The docked-terminal CLI a send would use, else null. */
  cli: TerminalCli | null;
  /** The external app a send would deep-link into, else null. */
  target: TargetData | null;
  /** True while the install probe hasn't answered — "detecting" vs "none". */
  probePending: boolean;
  /** Props to spread onto `AgentSplitButton`. */
  rows: {
    installedTargets: readonly TargetData[];
    selectedTargetId: TargetData['id'] | null;
    onSelectTarget: (target: TargetData) => void;
    terminals: readonly TerminalCliRow[] | undefined;
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
  const terminalLaunch = useTerminalLaunch();
  const { states } = useInstalledAgents();
  const registeredAgents = useRegisteredAgents();
  const defaultRegisteredAgent = useDefaultRegisteredAgent();
  // Mirrors the composer: the pick is applied immediately (and persisted), and
  // this local copy is what re-renders the checkmark.
  const [selectedId, setSelectedId] = useState<string | null>(() => loadStickyAgent());

  const enabledThreadAgents = registeredAgents.filter((agent) =>
    isInAppAgentEnabled(overrides, agent.source, agent.id, true, agent.supported),
  );
  const threadAgent = pickEffectiveDefaultAgent(enabledThreadAgents, defaultRegisteredAgent);

  const selection = resolveLauncherSelection({
    sticky: selectedId,
    effectiveThreadAgent: threadAgent,
    enabledClis:
      terminalLaunch !== null ? enabledTerminalClis(overrides, terminalLaunch.installedClis) : [],
    enabledDesktopTargets: enabledDesktopTargets(overrides),
    installedClis: terminalLaunch?.installedClis ?? {},
    terminalAvailable: terminalLaunch !== null,
    threadsAvailable: true,
    desktopSelectable: true,
  });

  const isThreadSelected = selection.kind === 'thread';
  const cli = selection.kind === 'cli' ? selection.cli : null;
  const target =
    selection.kind === 'desktop'
      ? (VISIBLE_TARGETS.find((entry) => entry.id === selection.target) ?? null)
      : null;

  // Every ENABLED app, not only the install-detected ones — an enabled but
  // uninstalled agent still lists and routes to its installer on launch.
  const installedTargets = VISIBLE_TARGETS.filter((entry) =>
    isDesktopTargetEnabled(overrides, entry.id),
  );

  const select = (id: string): void => {
    setSelectedId(id);
    saveStickyAgent(id);
  };

  const terminals: TerminalCliRow[] | undefined =
    terminalLaunch !== null
      ? enabledTerminalClis(overrides, terminalLaunch.installedClis).map((entry) => {
          const { displayName } = TERMINAL_CLIS[entry];
          return {
            cli: entry,
            label: displayName,
            // Accessible name carries "CLI" so it's distinguishable from a
            // same-named Desktop row (WCAG 2.5.3).
            ariaLabel: t`${displayName} CLI`,
            selected: cli === entry,
            onSelect: () => select(terminalCliId(entry)),
          };
        })
      : undefined;

  return {
    isThreadSelected,
    threadAgent,
    cli,
    target,
    probePending: VISIBLE_TARGETS.some((entry) => states[entry.id]?.installed == null),
    rows: {
      installedTargets,
      selectedTargetId: cli !== null ? null : (target?.id ?? null),
      onSelectTarget: (entry) => select(entry.id),
      terminals,
      threadAgents: enabledThreadAgents.map((agent) => ({
        key: `${agent.source}:${agent.id}`,
        id: agent.id,
        name: agent.name,
        ...(agent.iconUrl !== undefined ? { iconUrl: agent.iconUrl } : {}),
        selected:
          isThreadSelected &&
          threadAgent !== null &&
          threadAgent.source === agent.source &&
          threadAgent.id === agent.id,
        onSelect: () => {
          // Picking a specific agent re-registers it as the default a send
          // launches, then selects thread mode.
          registerAgent(agent);
          select(IN_APP_THREAD_ID);
        },
      })),
    },
  };
}
