/**
 * Right-click context submenu variant of the Open-in-Agent action, mounted
 * inside FileTree row ContextMenus.
 *
 * Behavior:
 *   - Render the targets `isDesktopTargetEnabled` admits: probed-installed,
 *     plus any explicitly enabled in Settings (those route to their
 *     installer), minus any turned off.
 *   - Detected desktop apps sit under an "External apps" section label; the docked
 *     terminal launchers — one row per enabled CLI (`isTerminalCliEnabled`:
 *     CLIs the probe hasn't ruled out) — sit under a "Terminal"
 *     section label, gated on a desktop terminal bridge.
 *   - Empty state: when no section has rows, only the Configure-agents item
 *     remains visible — no section labels, no hint text.
 *   - Status-hint code path remains for the `inputMissing` case (right-click
 *     on a node with no workspace metadata) — orthogonal to install state.
 *
 * Why a separate component from `OpenInAgentMenu` / `OpenInAgentMenuItem`:
 * the file-tree's right-click menu is mounted as a Radix `DropdownMenu` (see
 * `FileTreeMenu` in `FileTree.tsx`), not `@radix-ui/react-context-menu`. So
 * this component renders `DropdownMenu*` submenu primitives — identical to
 * the header `Sparkles` surface. The two callers diverge in row JSX shape
 * (this one inlines; the header reuses `OpenInAgentMenuItem`), not in the
 * menu primitive. Mixing the two Radix stacks would detach keyboard nav.
 *
 * Input construction is the caller's responsibility: FileTree computes
 * `input` from the right-clicked node (NOT the active doc) via
 * `buildHandoffInput({ docName: node.path, workspace })`.
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu.tsx';
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

/**
 * Status hint shown on the trigger row when the right-clicked node has no
 * workspace metadata (`inputMissing`). Install-state hints aren't shown — those
 * rows no longer render in this surface. `inputMissing` is orthogonal to
 * install state: every row is `disabled` when no workspace is available.
 */
export function contextRowHint(inputMissing: boolean): string | null {
  if (inputMissing) return t`No workspace`;
  return null;
}

interface OpenInAgentContextSubmenuProps {
  /** Handoff input for the right-clicked node. `null` means the row's dispatch
   *  is not actionable (no workspace metadata yet). Every row still renders
   *  disabled with a "No workspace" hint so the UX doesn't flicker. */
  readonly input: HandoffDispatchInput | null;
  /** Install state per target. Supplied by `FileTree`'s top-level
   *  `useInstalledAgents()` call so every file row shares one coordinator. */
  readonly installStates: Record<HandoffTarget, InstallState>;
  /** Host classifier — left in the prop signature for consumers that already
   *  thread it; the row's own install check decides dispatch-vs-installer, so
   *  it isn't read here.
   *  Web-host Cursor uses the same probe + filter as every other target now
   *  that `cursor-two-step.ts` has a `/api/spawn-cursor` fetch fallback. */
  readonly isElectronHost: boolean;
  /** `useHandoffDispatch().dispatch` from the FileTree caller. */
  readonly dispatch: (
    target: HandoffTarget,
    input: HandoffDispatchInput,
  ) => Promise<HandoffOutcome>;
  /** Fired right before any launch/dispatch — lets the FileTree caller dismiss
   *  its context menu before the agent surface takes over. */
  readonly onBeforeLaunch?: () => void;
}

export function OpenInAgentContextSubmenu(props: OpenInAgentContextSubmenuProps): ReactNode {
  const { t } = useLingui();
  const isEmbedded = useIsEmbedded();
  const terminalLaunch = useTerminalLaunch();
  const registeredAgents = useRegisteredAgents();
  const overrides = useEnabledOverrides();
  if (isEmbedded) return null;
  const { input, installStates, dispatch, onBeforeLaunch } = props;
  const inputMissing = input === null;
  const hint = contextRowHint(inputMissing);

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
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Sparkles aria-hidden="true" />
        <Trans>Open with AI</Trans>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80">
        {/* In-app agents — shown only when any is enabled; an empty section is
            hidden. Enablement is managed in Configure agents (footer). */}
        {showThreadSection ? (
          <DropdownMenuGroup aria-label={t`In app (beta)`}>
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <Trans>In app</Trans>
              <AgentBetaBadge />
            </DropdownMenuLabel>
            {enabledRegisteredAgents.map((agent) => {
              const agentName = agent.name;
              return (
                <DropdownMenuItem
                  key={`${agent.source}:${agent.id}`}
                  onSelect={() => {
                    if (input === null) return;
                    onBeforeLaunch?.();
                    startAgentThreadForInput(input, {
                      agent: { source: agent.source, id: agent.id },
                    });
                  }}
                  disabled={inputMissing}
                  data-testid={`file-tree-open-in-thread-${agent.id}`}
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
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ) : null}
        {showThreadSection && (showTerminalSection || showDesktopSection) ? (
          <DropdownMenuSeparator />
        ) : null}
        {showTerminalSection ? (
          // Terminal section leads (the in-app terminal is the first-class path).
          // Labeled `role="group"` so assistive tech announces the section the
          // visual header conveys (the label alone is skipped by arrow-key nav).
          <DropdownMenuGroup aria-label={t`Terminal`}>
            <DropdownMenuLabel>
              <Trans>Terminal</Trans>
            </DropdownMenuLabel>
            {/* Launches `claude` / `codex` / `cursor-agent` in the docked
                terminal with the right-clicked node's scope prompt. Visible
                text is the brand name; the accessible name is "<Brand> CLI"
                (plus the "No workspace" hint when input is missing), so it
                contains the visible label and AT users can tell it apart from a
                external-app row (WCAG 2.5.3 — name contains visible label). */}
            {terminalClis.map((cli) => {
              const { displayName } = TERMINAL_CLIS[cli];
              return (
                <DropdownMenuItem
                  key={cli}
                  onSelect={() => {
                    if (input === null) return;
                    onBeforeLaunch?.();
                    terminalLaunch.launchInTerminal(input, cli);
                  }}
                  disabled={inputMissing}
                  data-testid={`file-tree-open-in-terminal-${cli}`}
                  aria-label={hint ? t`${displayName} CLI, ${hint}` : t`${displayName} CLI`}
                >
                  <TargetIcon id={cliIconTargetId(cli)} aria-hidden="true" />
                  <span className="flex-1">{displayName}</span>
                  {hint ? (
                    <span aria-hidden="true" className="ml-2 text-muted-foreground text-xs">
                      {hint}
                    </span>
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ) : null}
        {showDesktopSection ? (
          // Detected desktop apps follow the Terminal section. Selecting one
          // hands the work OUT of OK — hence the external-action arrow on the
          // header and the "Desktop" suffix that tells each row apart from the
          // same-named Terminal row above it.
          <>
            {/* Separator only when a Terminal section sits above this one. */}
            {showTerminalSection ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup aria-label={t`External apps`}>
              <DropdownMenuLabel className="flex items-center gap-1.5">
                <Trans>External apps</Trans>
                <ArrowUpRight aria-hidden="true" className="size-3" />
              </DropdownMenuLabel>
              {enabledTargets.map((target) => {
                const enabled = !inputMissing;
                const { displayName } = target;
                const accessibleLabel = hint
                  ? t`Open with AI ${displayName} Desktop, ${hint}`
                  : t`Open with AI ${displayName} Desktop`;
                return (
                  <DropdownMenuItem
                    key={target.id}
                    disabled={!enabled}
                    onSelect={() => {
                      if (!input) return;
                      onBeforeLaunch?.();
                      // Enabled-but-not-installed → open the installer.
                      if (installStates[target.id]?.installed !== true) {
                        void openInstallUrl(target);
                        return;
                      }
                      void dispatch(target.id, input);
                    }}
                    data-testid={`file-tree-open-in-${target.id}`}
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
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </>
        ) : null}
        {/* Settings row — always last, always actionable. Opens Configure agents
            so the user manages which agents appear here (replaces the former
            "Choose another agent" catalog affordance). The separator only renders
            when a section sits above it, so the all-disabled menu isn't a lone rule. */}
        {showThreadSection || showTerminalSection || showDesktopSection ? (
          <DropdownMenuSeparator />
        ) : null}
        <DropdownMenuItem onSelect={openAgentSettings} data-testid="file-tree-open-in-settings">
          <SlidersHorizontal aria-hidden="true" />
          <span className="flex-1">
            <Trans>Configure agents</Trans>
          </span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
