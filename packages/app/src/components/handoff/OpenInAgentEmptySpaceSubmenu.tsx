/**
 * Sidebar-wide context menu variant of the Send-to-AI submenu, mounted inside
 * the FileSidebar's Radix `ContextMenu` wrapper (empty-space surface).
 *
 * Sibling to `OpenInAgentContextSubmenu` (which mounts inside Pierre's row
 * context menu using `DropdownMenuSub*`). Both surfaces share the same
 * install-state filter and dispatch — they diverge ONLY in the Radix submenu
 * primitive. This one renders `ContextMenuSub*` because the parent surface is
 * a Radix `ContextMenu`, not `DropdownMenu`; mixing the two Radix stacks (e.g.
 * `DropdownMenuSub` inside `ContextMenuContent`) detaches keyboard navigation
 * because Radix submenus inherit roving focus from their parent root primitive.
 *
 * Detected desktop apps sit under an "External apps" section label; the docked
 * terminal launchers — one row per enabled CLI (`isTerminalCliEnabled`: CLIs the
 * probe hasn't ruled out) — sit under a "Terminal" section label.
 *
 * The submenu always renders with at least the Configure-agents item; when no
 * agent section has rows, that item is all that remains (no section labels).
 */

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
import { AgentBetaBadge } from '@/components/acp/AgentBetaBadge';
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

/** Status hint shown alongside per-target rows when the input is not ready
 *  (workspace not resolved yet). Mirrors `contextRowHint` in the sibling
 *  submenu so accessibility-label phrasing stays in lockstep across surfaces. */
export function emptySpaceRowHint(inputMissing: boolean): string | null {
  if (inputMissing) return t`No workspace`;
  return null;
}

interface OpenInAgentEmptySpaceSubmenuProps {
  /** Handoff input for the active scope. `null` while workspace metadata
   *  is still resolving — rows still render disabled with a "No workspace"
   *  hint so the trigger doesn't appear/disappear during the cold-start
   *  fetch (visual stability matches `OpenInAgentContextSubmenu`). */
  readonly input: HandoffDispatchInput | null;
  /** Install state per target. Caller-owned via `useInstalledAgents()` so
   *  the empty-space + sparkle + row surfaces share one coordinator. */
  readonly installStates: Record<HandoffTarget, InstallState>;
  /** `useHandoffDispatch().dispatch` — fires URL builders + toast + telemetry. */
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

  // Rows are the desktop apps detected on this machine, minus anything the user
  // turned off in Configure agents. An explicitly enabled but not-installed app
  // still shows and routes to its installer on select.
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
  // Each section renders only when it has rows, so an empty header never shows.
  const showDesktopSection = enabledTargets.length > 0;
  // Keep the `terminalLaunch !== null` alias so TS narrows it inside the section.
  const showTerminalSection = terminalLaunch !== null && terminalClis.length > 0;
  const showThreadSection = enabledRegisteredAgents.length > 0;

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Sparkles aria-hidden="true" />
        <Trans>Open with AI</Trans>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-h-80">
        {/* In-app agents — shown only when any is enabled; an empty section is
            hidden. Enablement is managed in Configure agents (footer). */}
        {showThreadSection ? (
          <ContextMenuGroup aria-label={t`In app (beta)`}>
            <ContextMenuLabel className="flex items-center gap-1.5">
              <Trans>In app</Trans>
              <AgentBetaBadge />
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
          // Terminal section leads (the in-app terminal is the first-class path).
          // Labeled `role="group"` so assistive tech announces the section the
          // visual header conveys (the label alone is skipped by arrow-key nav).
          <ContextMenuGroup aria-label={t`Terminal`}>
            <ContextMenuLabel>
              <Trans>Terminal</Trans>
            </ContextMenuLabel>
            {/* Launches `claude` / `codex` / `cursor-agent` in the docked
                terminal with the project-scope prompt. Visible text is the
                brand name; the accessible name is "<Brand> CLI" (plus the "No
                workspace" hint when input is missing), so it contains the
                visible label and AT users can tell it apart from an external-app row
                (WCAG 2.5.3 — name contains visible label). */}
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
          // Detected desktop apps follow the Terminal section. Selecting one
          // hands the work OUT of OK — hence the external-action arrow on the
          // header and the "Desktop" suffix that tells each row apart from the
          // same-named Terminal row above it.
          <>
            {/* Separator only when a Terminal section sits above this one. */}
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
                      // Enabled-but-not-installed → open the installer.
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
        {/* Settings row — always last, always actionable. Opens Configure agents
            so the user manages which agents appear here (replaces the former
            "Choose another agent" catalog affordance). The separator only renders
            when a section sits above it, so the all-disabled menu isn't a lone rule. */}
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
