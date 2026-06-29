
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
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { TargetIcon } from './OpenInAgentMenuItem';
import { useTerminalLaunch } from './TerminalLaunchContext';
import { cliIconTargetId, VISIBLE_CLIS } from './terminal-cli-display';
import type { HandoffDispatchInput } from './useHandoffDispatch';

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
  readonly dispatch: (
    target: HandoffTarget,
    input: HandoffDispatchInput,
  ) => Promise<HandoffOutcome>;
}

export function OpenInAgentEmptySpaceSubmenu(props: OpenInAgentEmptySpaceSubmenuProps): ReactNode {
  const { t } = useLingui();
  const isEmbedded = useIsEmbedded();
  const terminalLaunch = useTerminalLaunch();
  if (isEmbedded) return null;
  const { input, installStates, dispatch } = props;
  const inputMissing = input === null;
  const hint = emptySpaceRowHint(inputMissing);

  const installedTargets = VISIBLE_TARGETS.filter(
    (target) => installStates[target.id]?.installed === true,
  );

  const showDesktopSection = installedTargets.length > 0;
  const showTerminalSection = terminalLaunch !== null;

  if (!showDesktopSection && !showTerminalSection) {
    return null;
  }

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Sparkles aria-hidden="true" />
        <Trans>Open with AI</Trans>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {showDesktopSection ? (
          <ContextMenuGroup aria-label={t`Desktop`}>
            <ContextMenuLabel>
              <Trans>Desktop</Trans>
            </ContextMenuLabel>
            {installedTargets.map((target) => {
              const enabled = !inputMissing;
              const { displayName } = target;
              const accessibleLabel = hint
                ? t`Open with AI ${displayName}, ${hint}`
                : t`Open with AI ${displayName}`;
              return (
                <ContextMenuItem
                  key={target.id}
                  disabled={!enabled}
                  onSelect={() => {
                    if (!input) return;
                    void dispatch(target.id, input);
                  }}
                  data-testid={`empty-space-open-in-${target.id}`}
                  aria-label={accessibleLabel}
                >
                  <TargetIcon id={target.id} aria-hidden="true" />
                  <span className="flex-1">{target.displayName}</span>
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
        {showTerminalSection ? (
          <>
            {/* Separator only when a Desktop section sits above this one. */}
            {showDesktopSection ? <ContextMenuSeparator /> : null}
            <ContextMenuGroup aria-label={t`Terminal`}>
              <ContextMenuLabel>
                <Trans>Terminal</Trans>
              </ContextMenuLabel>
              {/* Launches `claude` / `codex` / `cursor-agent` in the docked
                  terminal with the project-scope prompt. Visible text is the
                  brand name; the accessible name is "<Brand> CLI" (plus the "No
                  workspace" hint when input is missing), so it contains the
                  visible label and AT users can tell it apart from a Desktop row
                  (WCAG 2.5.3 — name contains visible label). */}
              {VISIBLE_CLIS.map((cli) => {
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
          </>
        ) : null}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
