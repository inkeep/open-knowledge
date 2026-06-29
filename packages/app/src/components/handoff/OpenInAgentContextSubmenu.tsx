
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
import { cliIconTargetId, VISIBLE_CLIS } from './terminal-cli-display';
import type { HandoffDispatchInput } from './useHandoffDispatch';

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

  const installedTargets = VISIBLE_TARGETS.filter(
    (target) => installStates[target.id]?.installed === true,
  );
  const probePending = VISIBLE_TARGETS.some(
    (target) => installStates[target.id]?.installed == null,
  );

  const showDesktopSection = installedTargets.length > 0;
  const showTerminalSection = terminalLaunch !== null;
  const showEmptyHint = !showDesktopSection && !showTerminalSection;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Sparkles aria-hidden="true" />
        <Trans>Open with AI</Trans>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {showDesktopSection ? (
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
        {showTerminalSection ? (
          <>
            {/* Separator only when a Desktop section sits above this one. */}
            {showDesktopSection ? <DropdownMenuSeparator /> : null}
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
              {VISIBLE_CLIS.map((cli) => {
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
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
