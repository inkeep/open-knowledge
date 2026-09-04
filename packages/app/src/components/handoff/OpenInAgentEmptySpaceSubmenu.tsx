// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import {
  type HandoffOutcome,
  type HandoffTarget,
  type InstallState,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import {
  isDesktopTargetEnabled,
  isInAppAgentEnabled,
  isTerminalCliEnabled,
} from '@/lib/acp/agent-visibility';
import { useEnabledOverrides } from '@/lib/acp/enabled-agents';
import { useRegisteredAgents } from '@/lib/acp/registered-agents';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { openAgentSettings } from '@/lib/use-settings-route';
import { DesktopAppName } from './agent-launcher-labels';
import { TargetIcon } from './OpenInAgentMenuItem';
import { useTerminalLaunch } from './TerminalLaunchContext';
import { cliIconTargetId } from './terminal-cli-display';
import {
  type HandoffDispatchInput,
  openInstallUrl,
  startAgentThreadForInput,
} from './useHandoffDispatch';

export function emptySpaceRowHint(inputMissing: boolean): string | null {
  if (inputMissing) return t`No workspace`;
  return null;
}

interface OpenInAgentEmptySpaceSubmenuProps {
  readonly input: HandoffDispatchInput | null;
  readonly installStates: Record<HandoffTarget, InstallState>;
  readonly dispatch: (
    target: HandoffTarget,
    input: HandoffDispatchInput,
  ) => Promise<HandoffOutcome>;
}

export function OpenInAgentEmptySpaceSubmenu(props: OpenInAgentEmptySpaceSubmenuProps): ReactNode {
  const { t } = useLingui();
  const isEmbedded = useIsEmbedded();
  const terminalLaunch = useTerminalLaunch();
  const registeredAgents = useRegisteredAgents();
  const overrides = useEnabledOverrides();
  if (isEmbedded) return null;
  const { input, installStates, dispatch } = props;
  const inputMissing = input === null;
  const hint = emptySpaceRowHint(inputMissing);

  const enabledTargets = VISIBLE_TARGETS.filter((target) =>
    isDesktopTargetEnabled(overrides, target.id, installStates[target.id]?.installed),
  );
  const enabledRegisteredAgents = registeredAgents.filter((agent) =>
    isInAppAgentEnabled(overrides, agent.source, agent.id, true, agent.supported),
  );

  const terminalClis = terminalLaunch
    ? TERMINAL_CLI_IDS.filter((cli) =>
        isTerminalCliEnabled(overrides, cli, terminalLaunch.installedClis),
      )
    : [];
  const showDesktopSection = enabledTargets.length > 0;
  const showTerminalSection = terminalLaunch !== null && terminalClis.length > 0;
  const showThreadSection = enabledRegisteredAgents.length > 0;

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Sparkles aria-hidden="true" />
        <Trans>Open with AI</Trans>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-h-80">
        {}
        {showThreadSection ? (
          <ContextMenuGroup aria-label={t`In app`}>
            <ContextMenuLabel>
              <Trans>In app</Trans>
            </ContextMenuLabel>
            {enabledRegisteredAgents.map((agent) => {
              const agentName = agent.name;
              return (
                <ContextMenuItem
                  key={`${agent.source}:${agent.id}`}
                  onSelect={() => {
                    if (input === null) return;
                    startAgentThreadForInput(input, {
                      agent: { source: agent.source, id: agent.id },
                    });
                  }}
                  disabled={inputMissing}
                  data-testid={`empty-space-open-in-thread-${agent.id}`}
                  aria-label={hint ? t`Ask ${agentName}, ${hint}` : t`Ask ${agentName}`}
                >
                  <RegisteredAgentIcon
                    agentId={agent.id}
                    iconUrl={agent.iconUrl}
                    className="size-4"
                  />
                  <span className="flex-1">{agentName}</span>
                  {hint ? (
                    <span aria-hidden="true" className="ml-2 text-muted-foreground text-xs">
                      {hint}
                    </span>
                  ) : null}
                </ContextMenuItem>
              );
            })}
          </ContextMenuGroup>
        ) : null}
        {showThreadSection && (showTerminalSection || showDesktopSection) ? (
          <ContextMenuSeparator />
        ) : null}
        {showTerminalSection ? (
          <ContextMenuGroup aria-label={t`Terminal`}>
            <ContextMenuLabel>
              <Trans>Terminal</Trans>
            </ContextMenuLabel>
            {}
            {terminalClis.map((cli) => {
              const { displayName } = TERMINAL_CLIS[cli];
              return (
                <ContextMenuItem
                  key={cli}
                  onSelect={() => {
                    if (input === null) return;
                    terminalLaunch.launchInTerminal(input, cli);
                  }}
                  disabled={inputMissing}
                  data-testid={`empty-space-open-in-terminal-${cli}`}
                  aria-label={hint ? t`${displayName} CLI, ${hint}` : t`${displayName} CLI`}
                >
                  <TargetIcon id={cliIconTargetId(cli)} aria-hidden="true" />
                  <span className="flex-1">{displayName}</span>
                  {hint ? (
                    <span aria-hidden="true" className="ml-2 text-muted-foreground text-xs">
                      {hint}
                    </span>
                  ) : null}
                </ContextMenuItem>
              );
            })}
          </ContextMenuGroup>
        ) : null}
        {showDesktopSection ? (
          <>
            {}
            {showTerminalSection ? <ContextMenuSeparator /> : null}
            <ContextMenuGroup aria-label={t`External apps`}>
              <ContextMenuLabel className="flex items-center gap-1.5">
                <Trans>External apps</Trans>
                <ArrowUpRight aria-hidden="true" className="size-3" />
              </ContextMenuLabel>
              {enabledTargets.map((target) => {
                const enabled = !inputMissing;
                const { displayName } = target;
                const accessibleLabel = hint
                  ? t`Open with AI ${displayName} Desktop, ${hint}`
                  : t`Open with AI ${displayName} Desktop`;
                return (
                  <ContextMenuItem
                    key={target.id}
                    disabled={!enabled}
                    onSelect={() => {
                      if (!input) return;
                      if (installStates[target.id]?.installed !== true) {
                        void openInstallUrl(target);
                        return;
                      }
                      void dispatch(target.id, input);
                    }}
                    data-testid={`empty-space-open-in-${target.id}`}
                    aria-label={accessibleLabel}
                  >
                    <TargetIcon id={target.id} aria-hidden="true" />
                    <span className="flex-1">
                      <DesktopAppName displayName={displayName} />
                    </span>
                    {hint ? (
                      <span aria-hidden="true" className="ml-2 text-muted-foreground text-xs">
                        {hint}
                      </span>
                    ) : null}
                  </ContextMenuItem>
                );
              })}
            </ContextMenuGroup>
          </>
        ) : null}
        {}
        {showThreadSection || showTerminalSection || showDesktopSection ? (
          <ContextMenuSeparator />
        ) : null}
        <ContextMenuItem onSelect={openAgentSettings} data-testid="empty-space-open-in-settings">
          <SlidersHorizontal aria-hidden="true" />
          <span className="flex-1">
            <Trans>Configure agents</Trans>
          </span>
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
