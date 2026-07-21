import type { HandoffTarget, TargetData, TerminalCli } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { AgentBetaBadge } from '@/components/acp/AgentBetaBadge';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
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

/**
 * Presentational split button that pairs a primary action with an agent picker:
 * `[ primary ▸ | ⌄ ]`. Shared by the empty-state "Create with <agent>" composer
 * and the footer "Ask <agent>" composer so the two surfaces can't drift.
 *
 * It owns only the view — the joined `ButtonGroup`, the primary button, and the
 * chevron menu listing the installed app agents ("Desktop") plus the optional
 * docked-terminal Claude CLI ("Terminal"). Everything stateful (which agent is
 * selected, where that preference is stored, what the primary button does, the
 * pending/disabled affordance, the label verb) stays in the parent and arrives
 * as props. The parent composes `primary` (icon + label + any spinner) and the
 * caller decides whether to render this at all (e.g. the empty-state swaps in a
 * disabled standalone button until an agent resolves).
 *
 * Uses a non-modal DropdownMenu (not a Popover): these are menu actions, but
 * "Choose another agent" hands directly to a modal dialog. A modal dropdown
 * would leave Radix's body pointer lock active during that handoff and make the
 * catalog appear frozen.
 */
/**
 * One CLI row in the "Terminal" section — a docked-terminal launcher for a
 * single CLI agent (Claude / Codex / Cursor). The parent supplies the visible
 * label + accessible name; the row reports its own selected check.
 */
export interface TerminalCliRow {
  /** Which CLI this row launches — drives the per-CLI sticky id + testid. */
  readonly cli: TerminalCli;
  /** Visible row text (e.g. "Claude"). */
  readonly label: ReactNode;
  /** Accessible name, distinct from a same-named Desktop row (WCAG 2.5.3). */
  readonly ariaLabel: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

/**
 * One registered in-app agent in the "In this app" section — selecting it
 * makes that agent the thread target (the parent owns registration/default
 * bumping). When any of these exist, they replace the single generic
 * "Start an agent" row so the first registration never locks the choice in.
 */
export interface ThreadAgentRow {
  /** Stable row key (`<source>:<id>`). */
  readonly key: string;
  /** Registry/custom agent id used to select a known local brand icon. */
  readonly id: string;
  /** Agent display name ("Claude Agent"). */
  readonly name: string;
  /** Registry-manifest icon URL, when any. */
  readonly iconUrl?: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

export interface AgentSplitButtonTestIds {
  /** The primary action button. */
  primary: string;
  /** The chevron menu trigger. */
  trigger: string;
  /** The menu content container. */
  menu: string;
  /** Per-agent option row, keyed by target id. */
  option: (id: HandoffTarget) => string;
  /**
   * The docked-terminal CLI row testid. A string applies to the single legacy
   * `terminal` slot; a function keys each row of the `terminals` array by CLI.
   */
  terminal: string | ((cli: TerminalCli) => string);
  /** Per-registered-agent thread row testid, keyed by the row key. */
  threadAgent?: (key: string) => string;
  /** The "Settings" row testid — opens Configure agents. */
  settings?: string;
}

export function AgentSplitButton({
  primary,
  onPrimary,
  primaryDisabled = false,
  installedTargets,
  selectedTargetId,
  onSelectTarget,
  threadAgents,
  onOpenSettings,
  terminal,
  terminals,
  menuEmptyState,
  onMenuOpenChange,
  menuAlign = 'end',
  triggerAriaLabel,
  testIds,
}: {
  /** Primary button content — icon + label (+ optional pending spinner). */
  primary: ReactNode;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  /** Installed app agents, rendered as the "Desktop" section. */
  installedTargets: readonly TargetData[];
  /** Checkmarked row; `null` when the terminal (or nothing) is selected. */
  selectedTargetId: HandoffTarget | null;
  onSelectTarget: (target: TargetData) => void;
  /**
   * Legacy single docked-terminal Claude CLI row. Omit on the web host (no
   * terminal). Superseded by {@link terminals} for the N-CLI picker — pass one
   * or the other, not both (`terminals` wins if both are set).
   */
  terminal?: { selected: boolean; onSelect: () => void };
  /**
   * Docked-terminal CLI rows — one per launchable CLI (Claude / Codex / Cursor).
   * Omit (or pass empty) on the web host. When non-empty, the "Terminal" section
   * renders these rows instead of the legacy single {@link terminal} slot.
   */
  terminals?: readonly TerminalCliRow[];
  /**
   * Enabled in-app agents, one selectable row each. When empty, the "In app"
   * group is hidden entirely (no generic fallback row).
   */
  threadAgents?: readonly ThreadAgentRow[];
  /**
   * Opens Settings → Configure agents — rendered as the last row of the menu so
   * the user manages which agents appear here. Replaces the former catalog
   * "Choose another agent…" affordance.
   */
  onOpenSettings: () => void;
  /** Rendered inside the menu when there are no app agents and no terminal. */
  menuEmptyState?: ReactNode;
  onMenuOpenChange?: (open: boolean) => void;
  menuAlign?: 'start' | 'end';
  triggerAriaLabel: string;
  testIds: AgentSplitButtonTestIds;
}) {
  const { t } = useLingui();
  const showDesktop = installedTargets.length > 0;
  const cliRows = terminals && terminals.length > 0 ? terminals : null;
  const showTerminal = cliRows != null || terminal != null;
  const hasOptions = showDesktop || showTerminal;
  const showThreadAgents = threadAgents !== undefined && threadAgents.length > 0;
  // The terminal-row testid is either a static string (legacy slot) or a
  // per-CLI function (N-row mode); normalize to a per-CLI resolver here.
  const terminalTestId = (cli: TerminalCli): string =>
    typeof testIds.terminal === 'function' ? testIds.terminal(cli) : testIds.terminal;

  return (
    // ButtonGroup joins the corners and collapses the seam to a single shared
    // 1px border between the two outline buttons — that shared border IS the
    // divider, so no ButtonGroupSeparator.
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
          {showThreadAgents ? (
            // In-app agent threads lead the menu when any is enabled; an empty
            // section (all disabled) is hidden entirely.
            <>
              <DropdownMenuGroup aria-label={t`In app (beta)`}>
                <DropdownMenuLabel className="flex items-center gap-1.5">
                  <Trans>In app</Trans>
                  <AgentBetaBadge />
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
                // Terminal section leads (the in-app terminal is the first-class
                // path). Labeled `role="group"` so assistive tech announces the
                // section the visual header conveys (the label alone is skipped by
                // arrow-key menu navigation).
                <DropdownMenuGroup aria-label={t`Terminal`}>
                  <DropdownMenuLabel>
                    <Trans>Terminal</Trans>
                  </DropdownMenuLabel>
                  {/* The visible text is the bare CLI name while the accessible
                      name carries "<name> CLI" so AT users can tell it apart
                      from a same-named Desktop row (WCAG 2.5.3 — the accessible
                      name contains the visible label). */}
                  {cliRows ? (
                    cliRows.map((row) => (
                      <DropdownMenuItem
                        key={row.cli}
                        onSelect={row.onSelect}
                        data-testid={terminalTestId(row.cli)}
                        aria-label={row.ariaLabel}
                      >
                        {/* Per-CLI brand icon (same source of truth the "Open
                            with AI" surfaces use via `cliIconTargetId`), so each
                            row is identifiable at a glance — OpenCode is
                            terminal-only and would otherwise show no brand mark.
                            The "Terminal" section header + the "(CLI)" label
                            already convey that these launch a terminal. */}
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
                // Desktop app launchers follow the Terminal section.
                <>
                  {showTerminal ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuGroup aria-label={t`Desktop`}>
                    <DropdownMenuLabel>
                      <Trans>Desktop</Trans>
                    </DropdownMenuLabel>
                    {installedTargets.map((target) => (
                      <DropdownMenuItem
                        key={target.id}
                        onSelect={() => onSelectTarget(target)}
                        data-testid={testIds.option(target.id)}
                      >
                        <TargetIcon id={target.id} aria-hidden="true" className="size-4" />
                        <span className="flex-1">{target.displayName}</span>
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
          {/* Empty state only when nothing at all is enabled (no in-app agents,
              no terminal, no desktop) — an empty section header never shows. */}
          {!showThreadAgents && !hasOptions ? menuEmptyState : null}
          {/* Settings row — always last. Opens Configure agents so the user
              manages which agents appear in this menu (replaces the former
              "Choose another agent" catalog affordance). The separator only
              renders when a section sits above it — when nothing is enabled the
              empty state reads with the footer as one unit, no lone rule. */}
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
