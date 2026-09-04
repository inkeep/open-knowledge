import type { HandoffTarget, TargetData, TerminalCli } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Check, ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { DesktopAppName } from '@/components/handoff/agent-launcher-labels';
import { TargetIcon } from '@/components/handoff/OpenInAgentMenuItem';
import { cliIconTargetId } from '@/components/handoff/terminal-cli-display';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface TerminalCliRow {
  readonly cli: TerminalCli;
  readonly label: ReactNode;
  readonly ariaLabel: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

export interface ThreadAgentRow {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly iconUrl?: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

export interface AgentSplitButtonTestIds {
  primary: string;
  trigger: string;
  menu: string;
  option: (id: HandoffTarget) => string;
  terminal: string | ((cli: TerminalCli) => string);
  threadAgent?: (key: string) => string;
  settings?: string;
}

export function AgentSplitButton({
  primary,
  onPrimary,
  primaryDisabled = false,
  enabledTargets,
  selectedTargetId,
  onSelectTarget,
  threadAgents,
  onOpenSettings,
  terminal,
  terminals,
  menuEmptyState,
  menuLeading,
  onMenuOpenChange,
  menuAlign = 'end',
  triggerAriaLabel,
  testIds,
}: {
  primary: ReactNode;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  enabledTargets: readonly TargetData[];
  selectedTargetId: HandoffTarget | null;
  onSelectTarget: (target: TargetData) => void;
  terminal?: { selected: boolean; onSelect: () => void };
  terminals?: readonly TerminalCliRow[];
  threadAgents?: readonly ThreadAgentRow[];
  onOpenSettings: () => void;
  menuEmptyState?: ReactNode;
  menuLeading?: ReactNode;
  onMenuOpenChange?: (open: boolean) => void;
  menuAlign?: 'start' | 'end';
  triggerAriaLabel: string;
  testIds: AgentSplitButtonTestIds;
}) {
  const { t } = useLingui();
  const showDesktop = enabledTargets.length > 0;
  const cliRows = terminals && terminals.length > 0 ? terminals : null;
  const showTerminal = cliRows != null || terminal != null;
  const hasOptions = showDesktop || showTerminal;
  const showThreadAgents = threadAgents !== undefined && threadAgents.length > 0;
  const terminalTestId = (cli: TerminalCli): string =>
    typeof testIds.terminal === 'function' ? testIds.terminal(cli) : testIds.terminal;

  return (
    <ButtonGroup>
      <Button
        type="button"
        variant="outline"
        className="gap-1.5"
        disabled={primaryDisabled}
        onClick={onPrimary}
        data-testid={testIds.primary}
      >
        {primary}
      </Button>
      <DropdownMenu modal={false} onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={triggerAriaLabel}
            data-testid={testIds.trigger}
          >
            <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={menuAlign}
          className="max-h-80 min-w-[200px]"
          data-testid={testIds.menu}
        >
          {}
          {menuLeading ? (
            <>
              {menuLeading}
              {showThreadAgents || hasOptions ? <DropdownMenuSeparator /> : null}
            </>
          ) : null}
          {showThreadAgents ? (
            <>
              <DropdownMenuGroup aria-label={t`In app`}>
                <DropdownMenuLabel>
                  <Trans>In app</Trans>
                </DropdownMenuLabel>
                {threadAgents?.map((row) => (
                  <DropdownMenuItem
                    key={row.key}
                    onSelect={row.onSelect}
                    data-testid={testIds.threadAgent?.(row.key)}
                  >
                    <RegisteredAgentIcon
                      agentId={row.id}
                      iconUrl={row.iconUrl}
                      className="size-4"
                    />
                    <span className="flex-1 truncate">{row.name}</span>
                    {row.selected ? (
                      <Check aria-hidden="true" className="size-4 text-muted-foreground" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              {hasOptions ? <DropdownMenuSeparator /> : null}
            </>
          ) : null}
          {hasOptions ? (
            <>
              {showTerminal ? (
                <DropdownMenuGroup aria-label={t`Terminal`}>
                  <DropdownMenuLabel>
                    <Trans>Terminal</Trans>
                  </DropdownMenuLabel>
                  {}
                  {cliRows ? (
                    cliRows.map((row) => (
                      <DropdownMenuItem
                        key={row.cli}
                        onSelect={row.onSelect}
                        data-testid={terminalTestId(row.cli)}
                        aria-label={row.ariaLabel}
                      >
                        {}
                        <TargetIcon
                          id={cliIconTargetId(row.cli)}
                          className="size-4"
                          aria-hidden="true"
                        />
                        <span className="flex-1">{row.label}</span>
                        {row.selected ? (
                          <Check aria-hidden="true" className="size-4 text-muted-foreground" />
                        ) : null}
                      </DropdownMenuItem>
                    ))
                  ) : terminal ? (
                    <DropdownMenuItem
                      onSelect={terminal.onSelect}
                      data-testid={terminalTestId('claude')}
                      aria-label={t`Claude CLI`}
                    >
                      <TargetIcon
                        id={cliIconTargetId('claude')}
                        className="size-4"
                        aria-hidden="true"
                      />
                      <span className="flex-1">
                        <Trans>Claude</Trans>
                      </span>
                      {terminal.selected ? (
                        <Check aria-hidden="true" className="size-4 text-muted-foreground" />
                      ) : null}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
              ) : null}
              {showDesktop ? (
                <>
                  {showTerminal ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuGroup aria-label={t`External apps`}>
                    <DropdownMenuLabel className="flex items-center gap-1.5">
                      <Trans>External apps</Trans>
                      <ArrowUpRight aria-hidden="true" className="size-3" />
                    </DropdownMenuLabel>
                    {enabledTargets.map((target) => (
                      <DropdownMenuItem
                        key={target.id}
                        onSelect={() => onSelectTarget(target)}
                        data-testid={testIds.option(target.id)}
                      >
                        <TargetIcon id={target.id} aria-hidden="true" className="size-4" />
                        <span className="flex-1">
                          <DesktopAppName displayName={target.displayName} />
                        </span>
                        {selectedTargetId === target.id ? (
                          <Check aria-hidden="true" className="size-4 text-muted-foreground" />
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </>
              ) : null}
            </>
          ) : null}
          {}
          {!showThreadAgents && !hasOptions ? menuEmptyState : null}
          {}
          {showThreadAgents || hasOptions ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={onOpenSettings} data-testid={testIds.settings}>
            <SlidersHorizontal aria-hidden="true" className="size-4 text-muted-foreground" />
            <span className="flex-1">
              <Trans>Configure agents</Trans>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
