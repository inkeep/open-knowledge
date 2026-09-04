import {
  type HandoffTarget,
  type InstallState,
  type TargetData,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, SlidersHorizontal, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import {
  isDesktopTargetEnabled,
  isInAppAgentEnabled,
  isTerminalCliEnabled,
} from '@/lib/acp/agent-visibility';
import { type EnabledOverrides, useEnabledOverrides } from '@/lib/acp/enabled-agents';
import { type RegisteredAgent, useRegisteredAgents } from '@/lib/acp/registered-agents';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { openAgentSettings } from '@/lib/use-settings-route';
import { DesktopAppName } from './agent-launcher-labels';
import { TargetIcon } from './OpenInAgentMenuItem';
import { type TerminalLaunchContextValue, useTerminalLaunch } from './TerminalLaunchContext';
import { cliIconTargetId } from './terminal-cli-display';
import {
  type HandoffDispatchInput,
  openInstallUrl,
  startAgentThreadForInput,
  useHandoffDispatch,
} from './useHandoffDispatch';
import { useInstalledAgents } from './useInstalledAgents';

interface OpenInAgentMenuProps {
  readonly input: HandoffDispatchInput | null;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

interface OpenWithAiPanelProps {
  readonly overrides: EnabledOverrides;
  readonly installStates: Record<HandoffTarget, InstallState>;
  readonly terminalLaunch: TerminalLaunchContextValue | null;
  readonly disabled: boolean;
  readonly registeredAgents: readonly RegisteredAgent[];
  readonly onPick: (target: TargetData, instruction: string) => void;
  readonly onLaunchTerminal: (cli: TerminalCli, instruction: string) => void;
  readonly onStartThreadWith: (
    agent: { source: 'registry' | 'custom'; id: string },
    instruction: string,
  ) => void;
  readonly onOpenSettings: () => void;
}

function OpenWithAiPanel({
  overrides,
  installStates,
  terminalLaunch,
  disabled,
  registeredAgents,
  onPick,
  onLaunchTerminal,
  onStartThreadWith,
  onOpenSettings,
}: OpenWithAiPanelProps): ReactNode {
  const { t } = useLingui();
  const [instruction, setInstruction] = useState('');

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
  const showTerminalSection = terminalClis.length > 0;
  const showThreadSection = enabledRegisteredAgents.length > 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="px-2 pt-2 pb-1.5">
        <Input
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder={t`What should the AI do? (optional)`}
          aria-label={t`Instruction for the AI`}
          data-testid="open-in-agent-instruction"
        />
      </div>
      {}
      <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto subtle-scrollbar">
        {}
        {showThreadSection ? (
          <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
            <legend
              className="px-1.5 py-1 font-medium text-muted-foreground text-xs"
              data-testid="open-in-agent-thread-label"
            >
              <Trans>In app</Trans>
            </legend>
            {enabledRegisteredAgents.map((agent) => {
              const agentName = agent.name;
              return (
                <Button
                  key={`${agent.source}:${agent.id}`}
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start gap-1.5 rounded-md px-1.5 py-1 font-normal text-foreground"
                  disabled={disabled}
                  data-testid={`open-in-agent-thread-start-${agent.id}`}
                  aria-label={t`Ask ${agentName}`}
                  onClick={() =>
                    onStartThreadWith({ source: agent.source, id: agent.id }, instruction)
                  }
                >
                  <RegisteredAgentIcon
                    agentId={agent.id}
                    iconUrl={agent.iconUrl}
                    className="size-4"
                  />
                  <span>{agentName}</span>
                </Button>
              );
            })}
          </fieldset>
        ) : null}
        {showThreadSection && (showTerminalSection || showDesktopSection) ? (
          <Separator className="my-1" />
        ) : null}
        <div className="flex flex-col gap-0.5">
          {showTerminalSection ? (
            <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
              <legend
                className="px-1.5 py-1 font-medium text-muted-foreground text-xs"
                data-testid="open-in-agent-terminal-label"
              >
                <Trans>Terminal</Trans>
              </legend>
              {terminalClis.map((cli) => {
                const { displayName } = TERMINAL_CLIS[cli];
                return (
                  <Button
                    key={cli}
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start gap-1.5 rounded-md px-1.5 py-1 font-normal text-foreground"
                    disabled={disabled}
                    data-testid={`open-in-agent-terminal-${cli}`}
                    aria-label={t`${displayName} CLI`}
                    onClick={() => onLaunchTerminal(cli, instruction)}
                  >
                    <TargetIcon id={cliIconTargetId(cli)} aria-hidden="true" />
                    <span>{displayName}</span>
                  </Button>
                );
              })}
            </fieldset>
          ) : null}
          {showDesktopSection ? (
            <>
              {showTerminalSection ? <Separator className="my-1" /> : null}
              <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
                <legend
                  className="flex items-center gap-1.5 px-1.5 py-1 font-medium text-muted-foreground text-xs"
                  data-testid="open-in-agent-desktop-label"
                >
                  <Trans>External apps</Trans>
                  <ArrowUpRight aria-hidden="true" className="size-3" />
                </legend>
                {enabledTargets.map((target) => {
                  const { displayName } = target;
                  return (
                    <Button
                      key={target.id}
                      type="button"
                      variant="ghost"
                      className="h-auto w-full justify-start gap-1.5 rounded-md px-1.5 py-1 font-normal text-foreground"
                      disabled={disabled}
                      data-testid={`open-in-agent-item-${target.id}`}
                      aria-label={t`Open with AI ${displayName} Desktop`}
                      onClick={() => onPick(target, instruction)}
                    >
                      <TargetIcon id={target.id} aria-hidden="true" />
                      <span>
                        <DesktopAppName displayName={displayName} />
                      </span>
                    </Button>
                  );
                })}
              </fieldset>
            </>
          ) : null}
        </div>
        {}
        {showThreadSection || showTerminalSection || showDesktopSection ? (
          <Separator className="my-1" />
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start gap-1.5 rounded-md px-1.5 py-1 font-normal text-foreground"
          data-testid="open-in-agent-settings"
          onClick={onOpenSettings}
        >
          <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden="true" />
          <span>{t`Configure agents`}</span>
        </Button>
      </div>
    </div>
  );
}

export function OpenInAgentMenu({ input, open, onOpenChange }: OpenInAgentMenuProps): ReactNode {
  const { t } = useLingui();
  const { states, refresh } = useInstalledAgents();
  const { dispatch } = useHandoffDispatch();
  const terminalLaunch = useTerminalLaunch();
  const registeredAgents = useRegisteredAgents();
  const overrides = useEnabledOverrides();
  const [internalOpen, setInternalOpen] = useState(false);
  const sawPointerDownRef = useRef(false);
  const isEmbedded = useIsEmbedded();

  const menuOpen = open ?? internalOpen;

  const refreshOnOpen = useEffectEvent(() => {
    void refresh();
  });
  useEffect(() => {
    if (menuOpen) refreshOnOpen();
  }, [menuOpen]);

  if (isEmbedded) return null;

  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;

  const handleOpenChange = (next: boolean): void => {
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  const triggerDisabled = input === null;

  const inputWith = (instruction: string): HandoffDispatchInput | null => {
    if (input === null) return null;
    const trimmed = instruction.trim();
    return trimmed ? { ...input, instruction: trimmed } : input;
  };

  const handlePick = (target: TargetData, instruction: string): void => {
    const next = inputWith(instruction);
    if (next === null) return;
    if (states[target.id]?.installed !== true) {
      void openInstallUrl(target);
      handleOpenChange(false);
      return;
    }
    void dispatch(target.id, next);
    handleOpenChange(false);
  };

  const handleLaunchTerminal = (cli: TerminalCli, instruction: string): void => {
    const next = inputWith(instruction);
    if (next === null || terminalLaunch === null) return;
    terminalLaunch.launchInTerminal(next, cli);
    handleOpenChange(false);
  };

  const handleStartThreadWith = (
    agent: { source: 'registry' | 'custom'; id: string },
    instruction: string,
  ): void => {
    const next = inputWith(instruction);
    if (next === null) return;
    startAgentThreadForInput(next, { agent });
    handleOpenChange(false);
  };

  return (
    <Popover open={menuOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={triggerDisabled}
          className="gap-1.5 text-muted-foreground px-1.5"
          data-testid="open-in-agent-trigger"
          onPointerDown={
            isElectronHost
              ? () => {
                  sawPointerDownRef.current = true;
                }
              : undefined
          }
          onClick={
            isElectronHost
              ? () => {
                  if (sawPointerDownRef.current) {
                    sawPointerDownRef.current = false;
                    return;
                  }
                  handleOpenChange(true);
                }
              : undefined
          }
        >
          <Sparkles className="size-3.5" aria-hidden="true" />
          <Trans>Open with AI</Trans>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="p-1"
        aria-label={t`Open with AI`}
        data-testid="open-in-agent-menu"
      >
        <OpenWithAiPanel
          overrides={overrides}
          installStates={states}
          terminalLaunch={terminalLaunch}
          disabled={input === null}
          registeredAgents={registeredAgents}
          onPick={handlePick}
          onLaunchTerminal={handleLaunchTerminal}
          onStartThreadWith={handleStartThreadWith}
          onOpenSettings={openAgentSettings}
        />
      </PopoverContent>
    </Popover>
  );
}
