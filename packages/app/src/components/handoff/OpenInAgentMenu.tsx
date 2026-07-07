/**
 * Popover surface for the toolbar "Open with AI" action.
 *
 * Unlike the right-click submenus (`OpenInAgentContextSubmenu` /
 * `OpenInAgentEmptySpaceSubmenu`), this surface hosts an instruction prompt box
 * above the installed-agent list — the same affordance the editor's "Edit with
 * AI" popover provides for selections. A text field cannot live inside a Radix
 * dropdown menu (the menu's typeahead steals keystrokes and arrow keys move
 * menu focus), so the prompt box requires the popover surface. The typed
 * instruction rides into the file / folder / project directive prompt via
 * `input.instruction` (see `selectScopedPrompt` in `useHandoffDispatch`), so it
 * reaches the deep-link dispatch and the docked-terminal launch alike.
 *
 * Behavior:
 *   - Render only targets where `states[t.id]?.installed === true`, scoped to
 *     `VISIBLE_TARGETS`.
 *   - Installed app launchers sit under a "Desktop" section label; the docked
 *     terminal launchers — one row per agent CLI in `VISIBLE_CLIS` (Claude,
 *     Codex, Cursor), each with a "<Brand> CLI" accessible name — sit under a
 *     "Terminal" section label. The terminal section is absent on the web host
 *     (`useTerminalLaunch()` is null — no shell).
 *   - Empty state: when nothing is install-detected and there is no terminal
 *     launcher, render a "No installed agents found" hint (no section labels).
 *
 * The `input` prop is supplied by the surface (EditorHeader). When `null` (no
 * active doc / workspace not loaded), the trigger is disabled.
 */

import {
  type HandoffTarget,
  type InstallState,
  type TargetData,
  TERMINAL_CLIS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { TargetIcon } from './OpenInAgentMenuItem';
import { type TerminalLaunchContextValue, useTerminalLaunch } from './TerminalLaunchContext';
import { cliIconTargetId, VISIBLE_CLIS } from './terminal-cli-display';
import { type HandoffDispatchInput, useHandoffDispatch } from './useHandoffDispatch';
import { useInstalledAgents } from './useInstalledAgents';

interface OpenInAgentMenuProps {
  /** Active doc context. When `null`, the trigger renders disabled (nothing
   *  to dispatch). Surfaces own the docContext + projectDir + docPath. */
  readonly input: HandoffDispatchInput | null;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

interface OpenWithAiPanelProps {
  readonly installStates: Record<HandoffTarget, InstallState>;
  /** Docked-terminal launcher when present (desktop); null on the web host. */
  readonly terminalLaunch: TerminalLaunchContextValue | null;
  /** Disable every dispatch row — set when there is nothing to dispatch
   *  (no active doc / workspace not loaded). The trigger is also disabled in
   *  that state, so this is a defensive guard for the controlled-open path. */
  readonly disabled: boolean;
  /** Fired when the user picks an agent; carries the typed instruction — the
   *  empty string when the user dispatched without typing one. */
  readonly onPick: (target: TargetData, instruction: string) => void;
  /** Fired when the user picks a CLI row; carries the chosen CLI + instruction. */
  readonly onLaunchTerminal: (cli: TerminalCli, instruction: string) => void;
}

/**
 * Popover body — the instruction input and the Desktop / Terminal row
 * sections. Pure: install state, the launcher, and the pick handlers are
 * injected, so it renders deterministically in tests without the dispatch /
 * install-probe hooks. Instruction state is local and resets on each open
 * because the popover unmounts its content when closed.
 */
function OpenWithAiPanel({
  installStates,
  terminalLaunch,
  disabled,
  onPick,
  onLaunchTerminal,
}: OpenWithAiPanelProps): ReactNode {
  const { t } = useLingui();
  const [instruction, setInstruction] = useState('');

  const installedTargets = VISIBLE_TARGETS.filter(
    (target) => installStates[target.id]?.installed === true,
  );
  const probePending = VISIBLE_TARGETS.some(
    (target) => installStates[target.id]?.installed == null,
  );

  // Two labeled sections orient the user: "Desktop" over the installed app
  // launchers, "Terminal" over the docked-terminal CLI rows. Both are
  // hidden in the empty state (no installed agents and no terminal launcher).
  const showDesktopSection = installedTargets.length > 0;
  const showTerminalSection = terminalLaunch !== null;
  const hasRows = showDesktopSection || showTerminalSection;

  return (
    <div className="flex flex-col gap-1">
      <div className="px-2 pt-2 pb-1.5">
        <Input
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder={t`What should the AI do? (optional)`}
          aria-label={t`Instruction for the AI`}
          data-testid="open-in-agent-instruction"
        />
      </div>
      {hasRows ? (
        <div className="flex flex-col gap-0.5">
          {showTerminalSection ? (
            // Terminal section leads (the in-app terminal is the first-class path).
            // CLI launchers run `claude` / `codex` / `cursor-agent` in the docked
            // terminal with the same scope prompt (plus instruction) the deep-link
            // puts in `q=`. Visible text is the brand name; the accessible name is
            // "<Brand> CLI" so AT users can tell each apart from the matching
            // Desktop row (WCAG 2.5.3 — the name contains the visible label).
            <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
              <legend
                className="px-1.5 py-1 font-medium text-muted-foreground text-xs"
                data-testid="open-in-agent-terminal-label"
              >
                <Trans>Terminal</Trans>
              </legend>
              {VISIBLE_CLIS.map((cli) => {
                const { displayName } = TERMINAL_CLIS[cli];
                return (
                  <Button
                    key={cli}
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start gap-1.5 rounded-md px-1.5 py-1 font-normal text-foreground"
                    disabled={disabled}
                    data-testid={`open-in-agent-terminal-${cli}`}
                    aria-label={t`${displayName} CLI`}
                    onClick={() => onLaunchTerminal(cli, instruction)}
                  >
                    <TargetIcon id={cliIconTargetId(cli)} aria-hidden="true" />
                    <span>{displayName}</span>
                  </Button>
                );
              })}
            </fieldset>
          ) : null}
          {showDesktopSection ? (
            // Desktop app launchers follow the Terminal section. The separator sits
            // OUTSIDE the <fieldset> — <legend> must be its first child.
            <>
              {showTerminalSection ? <Separator className="my-1" /> : null}
              <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
                <legend
                  className="px-1.5 py-1 font-medium text-muted-foreground text-xs"
                  data-testid="open-in-agent-desktop-label"
                >
                  <Trans>Desktop</Trans>
                </legend>
                {installedTargets.map((target) => {
                  // Destructure `displayName` so the Lingui macro emits the named
                  // placeholder `Open with AI {displayName}` — the same catalog
                  // message the sibling surfaces (OpenInAgentMenuItem, the submenus)
                  // already produce. Interpolating `target.displayName` directly
                  // would emit a positional `{0}` and fork a duplicate entry.
                  const { displayName } = target;
                  return (
                    <Button
                      key={target.id}
                      type="button"
                      variant="ghost"
                      className="h-auto w-full justify-start gap-1.5 rounded-md px-1.5 py-1 font-normal text-foreground"
                      disabled={disabled}
                      data-testid={`open-in-agent-item-${target.id}`}
                      aria-label={t`Open with AI ${displayName}`}
                      onClick={() => onPick(target, instruction)}
                    >
                      <TargetIcon id={target.id} aria-hidden="true" />
                      <span>{displayName}</span>
                    </Button>
                  );
                })}
              </fieldset>
            </>
          ) : null}
        </div>
      ) : (
        <p
          className="text-muted-foreground text-sm"
          data-testid="open-in-agent-empty"
          aria-live="polite"
        >
          {probePending ? (
            <Trans>Checking for installed agents</Trans>
          ) : (
            <Trans>No installed agents found</Trans>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Renders the popover trigger + content. Trigger is a `Sparkles` icon +
 * visible "Open with AI" label (the visible text is the accessible name — no
 * `aria-label`, which would override it and break WCAG 2.5.3 Label in Name).
 */
export function OpenInAgentMenu({ input, open, onOpenChange }: OpenInAgentMenuProps): ReactNode {
  const { t } = useLingui();
  const { states, refresh } = useInstalledAgents();
  const { dispatch } = useHandoffDispatch();
  const terminalLaunch = useTerminalLaunch();
  const [internalOpen, setInternalOpen] = useState(false);
  // Tracks whether a real `pointerdown` reached the trigger this interaction.
  // See the trigger's onPointerDown/onClick below for why this is load-bearing
  // on the Electron host.
  const sawPointerDownRef = useRef(false);
  const isEmbedded = useIsEmbedded();

  const menuOpen = open ?? internalOpen;

  // Refresh install state on the open edge — whether the open came from a
  // trigger click or a controlled `open` flip (the Electron click path and a
  // programmatic open both bypass Radix's own onOpenChange). `useEffectEvent`
  // keeps `refresh` out of the dependency array so the effect fires on the open
  // edge only. The probe coordinator handles throttle + dedup, so re-firing is
  // safe. Mirrors `EditWithAiPopover`. Declared before the embedded early-return
  // so the hook order stays stable across renders (rules of hooks).
  const refreshOnOpen = useEffectEvent(() => {
    void refresh();
  });
  useEffect(() => {
    if (menuOpen) refreshOnOpen();
  }, [menuOpen]);

  if (isEmbedded) return null;

  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;

  const handleOpenChange = (next: boolean): void => {
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  const triggerDisabled = input === null;

  // Thread the typed instruction onto the dispatch input. When empty, return
  // the bare `input` rather than `{ ...input, instruction: undefined }` so the
  // object stays structurally identical to the no-instruction input: the
  // deep-equality dispatch assertions and the prompt composer then see no
  // spurious `instruction` key.
  const inputWith = (instruction: string): HandoffDispatchInput | null => {
    if (input === null) return null;
    const trimmed = instruction.trim();
    return trimmed ? { ...input, instruction: trimmed } : input;
  };

  const handlePick = (target: TargetData, instruction: string): void => {
    const next = inputWith(instruction);
    if (next === null) return;
    void dispatch(target.id, next);
    handleOpenChange(false);
  };

  const handleLaunchTerminal = (cli: TerminalCli, instruction: string): void => {
    const next = inputWith(instruction);
    if (next === null || terminalLaunch === null) return;
    terminalLaunch.launchInTerminal(next, cli);
    handleOpenChange(false);
  };

  return (
    // Non-modal (Radix Popover default): keeps the rest of the chrome live and
    // never sets `body { pointer-events: none }`. The trigger lives in the
    // editor header's `-webkit-app-region: drag` zone, where the
    // outside-pointerdown a modal layer relies on for dismissal doesn't reliably
    // reach Radix (macOS swallows it at the OS chrome level); non-modal + the
    // `[data-electron-drag]` no-drag rule (globals.css) handle dismissal.
    <Popover open={menuOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={triggerDisabled}
          className="gap-1.5 text-muted-foreground px-1.5"
          data-testid="open-in-agent-trigger"
          // macOS swallows pointerdown inside the editor header's
          // `-webkit-app-region: drag` zone before the DOM sees it — even on
          // this `no-drag` button — so Radix's pointerdown-driven open never
          // fires in the desktop app and the menu won't open from a click.
          // The synthesized `click` still arrives, so on the Electron host we
          // open from it. The ref lets us tell the two paths apart: when a real
          // pointerdown reached us (browser always; Electron only once the menu
          // is open and the dismiss rule has flipped the header to no-drag),
          // Radix already handled the toggle and we stay out of the way; when
          // it didn't, the click is our only signal and we open. Browsers get
          // pointerdown normally, so we leave Radix's default untouched there.
          onPointerDown={
            isElectronHost
              ? () => {
                  sawPointerDownRef.current = true;
                }
              : undefined
          }
          onClick={
            isElectronHost
              ? () => {
                  if (sawPointerDownRef.current) {
                    sawPointerDownRef.current = false;
                    return;
                  }
                  handleOpenChange(true);
                }
              : undefined
          }
        >
          <Sparkles className="size-3.5" aria-hidden="true" />
          <Trans>Open with AI</Trans>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="p-1"
        aria-label={t`Open with AI`}
        data-testid="open-in-agent-menu"
      >
        <OpenWithAiPanel
          installStates={states}
          terminalLaunch={terminalLaunch}
          disabled={input === null}
          onPick={handlePick}
          onLaunchTerminal={handleLaunchTerminal}
        />
      </PopoverContent>
    </Popover>
  );
}
