import { TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  CheckIcon,
  ChevronDownIcon,
  PlusIcon,
  SlidersHorizontal,
  SquareTerminalIcon,
} from 'lucide-react';
import { useState } from 'react';
import { AgentBetaBadge } from '@/components/acp/AgentBetaBadge';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
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
import { fetchAgentCatalog } from '@/lib/acp/catalog';
import type { RegisteredAgent } from '@/lib/acp/registered-agents';
import type { NewSessionChoice } from '@/lib/new-session-choice';
import { cn } from '@/lib/utils';

interface TerminalNewChatButtonProps {
  /** The current primary pick — an in-app agent, a CLI, or a bare shell. Drives
   *  the primary icon/label and the dropdown checkmark. */
  readonly selected: NewSessionChoice;
  /** Primary click — launch the current {@link selected} pick. A plain launch: it
   *  does not change the pick. (When the pick is an agent with no concrete agent
   *  remembered, the host routes this to Configure agents instead.) */
  readonly onLaunchSelected: () => void;
  /** Render the in-app agent rows (the dock) — false in the standalone terminal
   *  window, which hosts only shells. */
  readonly showAgents: boolean;
  /** The user's registered agents (most-recently-registered first). */
  readonly registeredAgents: readonly RegisteredAgent[];
  /** Dropdown agent row — register it as the new default AND start a thread. */
  readonly onPickAgent: (agent: RegisteredAgent) => void;
  /** "Configure agents" row — opens the Configure agents settings tab. */
  readonly onOpenSettings: () => void;
  /** Live (non-archived) agent-thread count, checked against the server cap to
   *  disable the agent rows when the workspace is at its running-agent limit. */
  readonly liveThreadCount: number;
  /** Render the CLI + bare-Terminal rows (a desktop bridge with a PTY). */
  readonly showClis: boolean;
  /** Dropdown CLI row — make `cli` the new default (persist) AND open a tab in it. */
  readonly onPickCli: (cli: TerminalCli) => void;
  /** Dropdown "Terminal" row — make a bare shell the new default AND open one. */
  readonly onPickTerminal: () => void;
  /** The CLIs to list — already gated by the host via `isTerminalCliEnabled`
   *  (CLIs the probe hasn't ruled out, plus the current pick), so a CLI that's
   *  been probed absent doesn't appear. This is a presentational component: it
   *  renders the list as given. Falls back to the full {@link VISIBLE_CLIS} only
   *  for callers/tests that don't pass a gated list. */
  readonly visibleClis?: readonly TerminalCli[];
  readonly className?: string;
}

/**
 * The sessions dock's "new session" control: a split button pairing a primary
 * launch of the current pick with a dropdown to switch it across all three
 * families. The primary opens whatever is currently selected: a bare terminal, a
 * CLI chat, or an in-app agent thread. The menu mirrors the Ask-AI surfaces: an
 * "In this app" group (enabled agents), then — on the desktop host — a "Terminal"
 * group (every CLI plus a bare "Terminal" shell), then a "Configure agents" footer last.
 *
 * The pick sticks: agent + CLI picks via the shared Ask-AI store, the bare-terminal
 * pick via a terminal-only flag. The brand icon / agent avatar mirrors the Ask-AI
 * surfaces so a glance tells you what a new session will start.
 */
export function TerminalNewChatButton({
  selected,
  onLaunchSelected,
  showAgents,
  registeredAgents,
  onPickAgent,
  onOpenSettings,
  liveThreadCount,
  showClis,
  onPickCli,
  onPickTerminal,
  visibleClis = VISIBLE_CLIS,
  className,
}: TerminalNewChatButtonProps) {
  const { t } = useLingui();
  const [menuOpen, setMenuOpen] = useState(false);

  // Fetch the catalog lazily — only while the menu is open on a thread surface —
  // for the max-running-agents cap. Shares the `['acp-catalog']` query cache (and
  // 5-min staleness) with the catalog dialog, so opening the menu after browsing
  // the catalog is free. Default 8 until it resolves (matches the server default).
  const catalog = useQuery({
    queryKey: ['acp-catalog'],
    queryFn: ({ signal }) => fetchAgentCatalog(signal),
    enabled: menuOpen && showAgents,
    staleTime: 5 * 60 * 1000,
  });
  const maxThreads = catalog.data?.maxThreads ?? 8;
  const atCap = liveThreadCount >= maxThreads;

  // The `t` template macro is scope-bound, so the label is computed inline here
  // rather than in a helper that receives `t` as an argument.
  const primaryLabel =
    selected.kind === 'terminal'
      ? t`New terminal`
      : selected.kind === 'cli'
        ? t`New ${TERMINAL_CLIS[selected.cli].displayName} chat`
        : selected.agent !== null
          ? t`New ${selected.agent.name} chat`
          : t`Start an agent`;

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
            className="cursor-pointer gap-0.5 rounded-r-none px-1.5 text-muted-foreground hover:text-foreground"
            onClick={onLaunchSelected}
          >
            <NewSessionPrimaryIcon selected={selected} className="size-3.5" />
            <PlusIcon aria-hidden="true" className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>
          {primaryLabel}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t`Choose what a new session starts`}
            data-testid="terminal-new-chat-menu"
            className="cursor-pointer rounded-l-none text-muted-foreground hover:text-foreground"
          >
            <ChevronDownIcon aria-hidden="true" className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 min-w-[200px]">
          {/* Same section structure as the Ask-AI menus — an "In this app" group
              over the agent rows, a "Terminal" group over the CLIs, and a
              "Configure agents" footer last — so the dock picker reads consistently. The
              bare "Terminal" (plain shell) is the last row of the Terminal group,
              where it belongs alongside the CLIs. */}
          {showAgents && registeredAgents.length > 0 ? (
            <DropdownMenuGroup aria-label={t`In app (beta)`}>
              <DropdownMenuLabel className="flex items-center gap-1.5">
                <Trans>In app</Trans>
                <AgentBetaBadge />
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
                    disabled={atCap}
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
                    // The accessible name carries "<name> CLI" so it is distinct and
                    // unambiguous (matches the Ask-AI Terminal rows, WCAG 2.5.3).
                    aria-label={t`${name} CLI`}
                    // `aria-current` over menuitemradio: each row both selects a
                    // default AND launches, so radio semantics overstate the
                    // selection aspect (WCAG 1.3.1).
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
              {/* Bare shell — last row of the Terminal group. */}
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
          {/* Settings — the global footer, last in every menu (matches the Ask-AI
              surfaces). Opens Configure agents; only on the agent-hosting dock,
              never the standalone terminal window. "Settings" is never capped. */}
          {showAgents ? (
            <>
              {/* Separator only when a section sits above it, so the all-disabled
                  dock menu isn't a lone rule over the footer. */}
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

/** Primary-button icon for the current pick (brand icon / agent avatar / shell). */
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
