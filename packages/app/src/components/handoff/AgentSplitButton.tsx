import type { HandoffTarget, TargetData, TerminalCli } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
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
 * Uses a DropdownMenu (not a Popover): the Electron pointerdown hazard only
 * bites Radix triggers inside `-webkit-app-region: drag` chrome, and both
 * consumers sit in the content area. See ProjectSwitcher for the drag-region
 * case that genuinely needs the workaround.
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
}

export function AgentSplitButton({
  primary,
  onPrimary,
  primaryDisabled = false,
  installedTargets,
  selectedTargetId,
  onSelectTarget,
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
      <DropdownMenu onOpenChange={onMenuOpenChange}>
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
        <DropdownMenuContent align={menuAlign} className="min-w-[200px]" data-testid={testIds.menu}>
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
          ) : (
            menuEmptyState
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
