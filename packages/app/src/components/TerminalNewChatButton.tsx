import { TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Bot,
  CheckIcon,
  ChevronDownIcon,
  PlusIcon,
  SlidersHorizontal,
  SquareTerminalIcon,
} from 'lucide-react';
import { useState } from 'react';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { AgentSplitButton } from '@/components/handoff/AgentSplitButton';
import { TargetIcon } from '@/components/handoff/OpenInAgentMenuItem';
import { cliIconTargetId, VISIBLE_CLIS } from '@/components/handoff/terminal-cli-display';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAgentCatalogQuery } from '@/lib/acp/catalog';
import type { RegisteredAgent } from '@/lib/acp/registered-agents';
import type { NewSessionChoice } from '@/lib/new-session-choice';
import { cn } from '@/lib/utils';

interface TerminalNewChatButtonProps {
  readonly selected: NewSessionChoice;
  readonly onLaunchSelected: () => void;
  readonly showAgents: boolean;
  readonly registeredAgents: readonly RegisteredAgent[];
  readonly onPickAgent: (agent: RegisteredAgent) => void;
  readonly onOpenSettings: () => void;
  readonly liveThreadCount: number;
  readonly agentPickPending?: boolean;
  readonly showClis: boolean;
  readonly onPickCli: (cli: TerminalCli) => void;
  readonly onPickTerminal: () => void;
  readonly visibleClis?: readonly TerminalCli[];
  readonly className?: string;
  readonly presentation?: 'toolbar' | 'panel';
}

export function TerminalNewChatButton({
  selected,
  onLaunchSelected,
  showAgents,
  registeredAgents,
  onPickAgent,
  onOpenSettings,
  liveThreadCount,
  agentPickPending = false,
  showClis,
  onPickCli,
  onPickTerminal,
  visibleClis = VISIBLE_CLIS,
  className,
  presentation = 'toolbar',
}: TerminalNewChatButtonProps) {
  const { t } = useLingui();
  const [menuOpen, setMenuOpen] = useState(false);

  const catalog = useAgentCatalogQuery(menuOpen && showAgents);
  const maxThreads = catalog.data?.maxThreads ?? 8;
  const atCap = liveThreadCount >= maxThreads;
  const agentsDisabled = atCap || agentPickPending;
  const hasMenu = showAgents || showClis;
  const panel = presentation === 'panel';
  const agentName = selected.kind === 'agent' ? selected.agent?.name : undefined;

  const primaryLabel =
    selected.kind === 'terminal'
      ? t`New terminal`
      : selected.kind === 'cli'
        ? t`New ${TERMINAL_CLIS[selected.cli].displayName} chat`
        : agentName !== undefined
          ? t`New chat with ${agentName}`
          : t`Start an agent`;
  const visiblePrimaryLabel = panel && agentName !== undefined ? t`New chat` : primaryLabel;

  if (panel) {
    return (
      <AgentSplitButton
        className={cn('w-full', className)}
        primaryClassName="min-w-0 flex-1 justify-start"
        primary={
          <>
            {selected.kind === 'terminal' ? null : (
              <NewSessionPrimaryIcon selected={selected} className="size-4" />
            )}
            <span className="truncate">{visiblePrimaryLabel}</span>
          </>
        }
        primaryAriaLabel={primaryLabel}
        onPrimary={onLaunchSelected}
        enabledTargets={[]}
        selectedTargetId={null}
        onSelectTarget={() => {}}
        threadAgents={
          showAgents
            ? registeredAgents.map((agent) => ({
                key: `${agent.source}:${agent.id}`,
                id: agent.id,
                name: agent.name,
                ...(agent.iconUrl !== undefined ? { iconUrl: agent.iconUrl } : {}),
                selected:
                  selected.kind === 'agent' &&
                  selected.agent?.source === agent.source &&
                  selected.agent?.id === agent.id,
                disabled: agentsDisabled,
                onSelect: () => onPickAgent(agent),
              }))
            : undefined
        }
        threadAgentsFooter={
          atCap ? (
            <DropdownMenuLabel
              className="py-1 font-normal text-muted-foreground text-xs"
              data-testid="terminal-new-chat-cap"
            >
              <Trans>Maximum agents already running</Trans>
            </DropdownMenuLabel>
          ) : undefined
        }
        terminals={
          showClis
            ? visibleClis.map((cli) => ({
                cli,
                label: TERMINAL_CLIS[cli].displayName,
                ariaLabel: t`${TERMINAL_CLIS[cli].displayName} CLI`,
                selected: selected.kind === 'cli' && selected.cli === cli,
                onSelect: () => onPickCli(cli),
              }))
            : undefined
        }
        terminal={
          showClis
            ? {
                selected: selected.kind === 'terminal',
                onSelect: onPickTerminal,
                label: t`Terminal`,
                icon: <SquareTerminalIcon aria-hidden="true" className="size-4" />,
                ariaLabel: t`Terminal`,
                testId: 'terminal-new-chat-terminal',
              }
            : undefined
        }
        onOpenSettings={onOpenSettings}
        onMenuOpenChange={setMenuOpen}
        menuAlign="start"
        triggerAriaLabel={t`Choose what a new chat starts`}
        testIds={{
          primary: 'terminal-new-chat',
          trigger: 'terminal-new-chat-menu',
          menu: 'terminal-new-chat-menu-content',
          option: (id) => `terminal-new-chat-option-${id}`,
          terminal: (cli) => `terminal-new-chat-cli-${cli}`,
          threadAgent: (key) =>
            `terminal-new-chat-agent-${registeredAgents.find((agent) => `${agent.source}:${agent.id}` === key)?.id ?? key}`,
          settings: 'terminal-new-chat-settings',
        }}
      />
    );
  }

  return (
    <div className={cn('flex shrink-0 items-center', className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={primaryLabel}
            data-testid="terminal-new-chat"
            className={cn(
              'cursor-pointer gap-0.5 px-1.5 text-muted-foreground hover:text-foreground',
              hasMenu && 'rounded-r-none',
            )}
            onClick={onLaunchSelected}
          >
            {selected.kind === 'terminal' ? null : (
              <NewSessionPrimaryIcon selected={selected} className="size-3.5" />
            )}
            <PlusIcon aria-hidden="true" className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>
          {primaryLabel}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        {hasMenu ? (
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t`Choose what a new tab starts`}
              data-testid="terminal-new-chat-menu"
              className="cursor-pointer rounded-s-none text-muted-foreground hover:text-foreground"
            >
              <ChevronDownIcon aria-hidden="true" className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        ) : null}
        <DropdownMenuContent align="start" className="max-h-80 min-w-[200px]">
          {}
          {showAgents && registeredAgents.length > 0 ? (
            <DropdownMenuGroup aria-label={t`In app`}>
              <DropdownMenuLabel>
                <Trans>In app</Trans>
              </DropdownMenuLabel>
              {registeredAgents.map((agent) => {
                const isSelected =
                  selected.kind === 'agent' &&
                  selected.agent?.source === agent.source &&
                  selected.agent?.id === agent.id;
                return (
                  <DropdownMenuItem
                    key={`${agent.source}:${agent.id}`}
                    onSelect={() => onPickAgent(agent)}
                    disabled={agentsDisabled}
                    data-testid={`terminal-new-chat-agent-${agent.id}`}
                    aria-current={isSelected ? 'true' : undefined}
                  >
                    <RegisteredAgentIcon
                      agentId={agent.id}
                      iconUrl={agent.iconUrl}
                      className="size-4"
                    />
                    <span className="flex-1 truncate">{agent.name}</span>
                    {isSelected ? (
                      <CheckIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
              {atCap ? (
                <DropdownMenuLabel
                  className="py-1 font-normal text-muted-foreground text-xs"
                  data-testid="terminal-new-chat-cap"
                >
                  <Trans>Maximum agents already running</Trans>
                </DropdownMenuLabel>
              ) : null}
            </DropdownMenuGroup>
          ) : null}
          {showAgents && registeredAgents.length > 0 && showClis ? <DropdownMenuSeparator /> : null}
          {showClis ? (
            <DropdownMenuGroup aria-label={t`Terminal`}>
              <DropdownMenuLabel>
                <Trans>Terminal</Trans>
              </DropdownMenuLabel>
              {visibleClis.map((cli) => {
                const { displayName: name } = TERMINAL_CLIS[cli];
                const isSelected = selected.kind === 'cli' && selected.cli === cli;
                return (
                  <DropdownMenuItem
                    key={cli}
                    onSelect={() => onPickCli(cli)}
                    data-testid={`terminal-new-chat-cli-${cli}`}
                    aria-label={t`${name} CLI`}
                    aria-current={isSelected ? 'true' : undefined}
                  >
                    <TargetIcon id={cliIconTargetId(cli)} className="size-4" aria-hidden="true" />
                    <span className="flex-1">{name}</span>
                    {isSelected ? (
                      <CheckIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
              {}
              <DropdownMenuItem
                onSelect={onPickTerminal}
                data-testid="terminal-new-chat-terminal"
                aria-current={selected.kind === 'terminal' ? 'true' : undefined}
              >
                <SquareTerminalIcon aria-hidden="true" className="size-4" />
                <span className="flex-1">
                  <Trans>Terminal</Trans>
                </span>
                {selected.kind === 'terminal' ? (
                  <CheckIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                ) : null}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          ) : null}
          {}
          {showAgents ? (
            <>
              {}
              {registeredAgents.length > 0 || showClis ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={onOpenSettings} data-testid="terminal-new-chat-settings">
                <SlidersHorizontal aria-hidden="true" className="size-4 text-muted-foreground" />
                <span className="flex-1">
                  <Trans>Configure agents</Trans>
                </span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function NewSessionPrimaryIcon({
  selected,
  className,
}: {
  selected: NewSessionChoice;
  className?: string;
}) {
  if (selected.kind === 'terminal') {
    return <SquareTerminalIcon aria-hidden="true" className={className} />;
  }
  if (selected.kind === 'cli') {
    return (
      <TargetIcon id={cliIconTargetId(selected.cli)} className={className} aria-hidden="true" />
    );
  }
  if (selected.agent !== null) {
    return (
      <RegisteredAgentIcon
        agentId={selected.agent.id}
        iconUrl={selected.agent.iconUrl}
        className={className}
      />
    );
  }
  return <Bot aria-hidden="true" className={className} />;
}
