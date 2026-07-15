/**
 * Right-click context submenu variant of the Open-in-Agent action, mounted
 * inside FileTree row ContextMenus.
 *
 * Behavior:
 *   - Render only targets where `installStates[t.id].installed === true`.
 *   - Installed app launchers sit under a "Desktop" section label; the docked
 *     terminal launchers — one row per PATH-gated CLI (`visibleTerminalClis`:
 *     Claude plus CLIs the probe hasn't ruled out) — sit under a "Terminal"
 *     section label, gated on a desktop terminal bridge.
 *   - Empty state: when no targets are install-detected and there is no
 *     terminal launcher, render a disabled "No installed agents found" item
 *     (no section labels then).
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

import {
  type HandoffOutcome,
  type HandoffTarget,
  type InstallState,
  TERMINAL_CLIS,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
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
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { TargetIcon } from './OpenInAgentMenuItem';
import { useTerminalLaunch } from './TerminalLaunchContext';
import { cliIconTargetId, visibleTerminalClis } from './terminal-cli-display';
import type { HandoffDispatchInput } from './useHandoffDispatch';

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
   *  thread it; uninstalled rows aren't rendered so it isn't read here.
   *  Web-host Cursor uses the same probe + filter as every other target now
   *  that `cursor-two-step.ts` has a `/api/spawn-cursor` fetch fallback. */
  readonly isElectronHost: boolean;
  /** `useHandoffDispatch().dispatch` from the FileTree caller. */
  readonly dispatch: (
    target: HandoffTarget,
    input: HandoffDispatchInput,
  ) => Promise<HandoffOutcome>;
}

export function OpenInAgentContextSubmenu(props: OpenInAgentContextSubmenuProps): ReactNode {
  const { t } = useLingui();
  const isEmbedded = useIsEmbedded();
  const terminalLaunch = useTerminalLaunch();
  if (isEmbedded) return null;
  const { input, installStates, dispatch } = props;
  const inputMissing = input === null;
  const hint = contextRowHint(inputMissing);

  // Filter: render only installed targets. Web-host Cursor is already forced
  // to `installed: false` upstream in `useInstalledAgents`, so the filter
  // subsumes that case too.
  const installedTargets = VISIBLE_TARGETS.filter(
    (target) => installStates[target.id]?.installed === true,
  );
  const probePending = VISIBLE_TARGETS.some(
    (target) => installStates[target.id]?.installed == null,
  );

  const showDesktopSection = installedTargets.length > 0;
  // Desktop-only: `useTerminalLaunch()` is null on the web host (no shell).
  const showTerminalSection = terminalLaunch !== null;
  // When nothing is install-detected and there's no terminal launcher to fall
  // back on, surface a disabled hint rather than an empty flyout.
  const showEmptyHint = !showDesktopSection && !showTerminalSection;
  // Claude plus every CLI the probe hasn't ruled out (fail-open); no "current
  // pick" to preserve on this launch-only submenu, so no `keep`.
  const terminalClis = terminalLaunch ? visibleTerminalClis(terminalLaunch.installedClis) : [];

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Sparkles aria-hidden="true" />
        <Trans>Open with AI</Trans>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
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
                Desktop row (WCAG 2.5.3 — name contains visible label). */}
            {terminalClis.map((cli) => {
              const { displayName } = TERMINAL_CLIS[cli];
              return (
                <DropdownMenuItem
                  key={cli}
                  onSelect={() => {
                    if (input === null) return;
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
          // Desktop app launchers follow the Terminal section.
          <>
            {/* Separator only when a Terminal section sits above this one. */}
            {showTerminalSection ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup aria-label={t`Desktop`}>
              <DropdownMenuLabel>
                <Trans>Desktop</Trans>
              </DropdownMenuLabel>
              {installedTargets.map((target) => {
                const enabled = !inputMissing;
                const { displayName } = target;
                const accessibleLabel = hint
                  ? t`Open with AI ${displayName}, ${hint}`
                  : t`Open with AI ${displayName}`;
                return (
                  <DropdownMenuItem
                    key={target.id}
                    disabled={!enabled}
                    onSelect={() => {
                      if (!input) return;
                      void dispatch(target.id, input);
                    }}
                    data-testid={`file-tree-open-in-${target.id}`}
                    aria-label={accessibleLabel}
                  >
                    <TargetIcon id={target.id} aria-hidden="true" />
                    <span className="flex-1">{target.displayName}</span>
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
        {showEmptyHint ? (
          <DropdownMenuItem disabled data-testid="file-tree-open-in-empty">
            {probePending ? (
              <Trans>Checking for installed agents</Trans>
            ) : (
              <Trans>No installed agents found</Trans>
            )}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
