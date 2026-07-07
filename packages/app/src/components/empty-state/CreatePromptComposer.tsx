import { type HandoffTarget, TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Check, ChevronDown, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraftDoc,
} from '@/components/composer-draft-store';
import {
  type CreateScenario,
  useCreateSuggestions,
} from '@/components/empty-state/use-create-suggestions';
import { TargetIcon } from '@/components/handoff/OpenInAgentMenuItem';
import { useTerminalLaunch } from '@/components/handoff/TerminalLaunchContext';
import { cliIconTargetId, VISIBLE_CLIS } from '@/components/handoff/terminal-cli-display';
import {
  buildCreateHandoffInput,
  getDisplayNameDefault,
  openInstallUrl,
  useHandoffDispatch,
} from '@/components/handoff/useHandoffDispatch';
import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
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
import {
  ComposerMentionInput,
  type ComposerMentionInputHandle,
} from '@/editor/ComposerMentionInput';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { hasValidPromptInput } from '@/lib/has-valid-prompt-input';
import {
  readPreferredAgent,
  resolvePreferredAgent,
  writePreferredAgent,
} from '@/lib/preferred-agent-store';
import { useWorkspace } from '@/lib/use-workspace';
import { cn } from '@/lib/utils';

interface CreatePromptComposerProps {
  readonly scenario: CreateScenario;
  readonly className?: string;
}

/**
 * Empty-state prompt composer — a free-form `@`-mention input (the shared
 * `ComposerMentionInput`, so the brief can reference existing docs/files as
 * `@path` chips) plus a split "Create with <agent>" button. Typing a brief and
 * creating hands it off to the selected coding agent via `useHandoffDispatch`
 * (the same dispatch path as the editor's "Open with AI" surface), which
 * composes the create-scope prompt — brief + the explicit `@path` mentions — so
 * the agent scaffolds the project to match.
 *
 * The chevron menu has two sections. "Desktop" lists installed agents only (no
 * web fallback, so an agent that can't be launched is never offered — mirrors
 * the "Open with AI" menu); picking one sets the default the primary button
 * creates with. "Terminal" (desktop only) adds a row per agent CLI (Claude,
 * Codex, Cursor) that launches the docked-terminal CLI with the same
 * create-scope input. The two differ on purpose: every row selects the create
 * target — Desktop items pick an installed app agent, a Terminal row picks the
 * docked-terminal CLI — and the Create button performs the selected target (app
 * deep-link or terminal launch).
 * When nothing is installed, Create is disabled and the footer shows a "no
 * agents" hint.
 *
 * Render-gated by the caller on `useIsEmbedded()` — when OK runs inside a host
 * agent (Cursor/Codex/Claude) the handoff would loop back, so the caller swaps
 * in `CopyablePromptList` there instead.
 */
export function CreatePromptComposer({ scenario, className }: CreatePromptComposerProps) {
  const { t } = useLingui();
  const { states, refresh } = useInstalledAgents();
  const { dispatch } = useHandoffDispatch();
  const workspace = useWorkspace();
  // Null on the web host (no docked terminal); non-null only on desktop. Gates
  // the chevron menu's "Terminal" launch section.
  const terminalLaunch = useTerminalLaunch();

  // Optimistic sync init from device-local memory (no cold-start flash); the
  // probe-reconcile effect below corrects it once install state resolves. `null`
  // means "no agent chosen yet" (first run) or "no installed agent" (post-probe).
  const [selectedAgentId, setSelectedAgentId] = useState<HandoffTarget | null>(() =>
    readPreferredAgent(),
  );
  // Once the user explicitly picks an agent this session, stop auto-reconciling
  // — their choice is authoritative even if the probe later disagrees.
  const userPickedRef = useRef(false);
  // Which docked-terminal CLI is the chosen create target (vs an installed app
  // agent); null when an app agent is selected. Session-only — the
  // preferred-agent store is app-only.
  const [selectedCli, setSelectedCli] = useState<TerminalCli | null>(null);
  // The CLI is the active create target only when one is selected AND the
  // docked terminal is available (the web host has no shell).
  const cliSelected = selectedCli !== null && terminalLaunch !== null;

  const inputRef = useRef<ComposerMentionInputHandle>(null);

  // Shared draft doc — the SAME store the bottom docked composer reads/writes, so
  // a brief typed there (chips included) carries into this create screen (and
  // back), and survives reload. Seed the field from the stored ProseMirror doc
  // once on mount so `@`-mentions restore as atomic chips, not literal `@path`
  // text; mirror every keystroke back.
  const [initialDraftDoc] = useState(() => getComposerDraft().doc ?? undefined);

  // The create screen requires intent before it acts — an empty brief is no
  // longer a "set up a generic project" shortcut. The input reports emptiness
  // (no prose AND no `@`-chips) via `onEmptyChange`; that maps exactly to
  // `!hasValidPromptInput(instruction, mentions, false)` (this surface has no
  // selection), so it guards the dispatch sites below.
  const [isEmpty, setIsEmpty] = useState(true);

  // The input-required message is opt-in, not a permanent label: it stays hidden
  // until the user *attempts* to create with an empty brief, then surfaces in the
  // app's standard inline-validation style (matches NewItemDialog — a
  // `role="alert"` `text-destructive` line). Cleared the moment valid input
  // arrives. A natively-disabled button can't fire click, so the Create primary
  // stays clickable on empty input and routes the attempt here instead.
  const [showRequiredError, setShowRequiredError] = useState(false);

  // Field reports non-empty → any pending requirement error is now stale.
  function handleEmptyChange(nextEmpty: boolean) {
    setIsEmpty(nextEmpty);
    if (!nextEmpty) setShowRequiredError(false);
  }

  // Starter-brief chips, per surface — shared with the embedded CopyablePromptList.
  const suggestions = useCreateSuggestions(scenario);

  // Installed agents only — there's no web fallback, so an agent that can't be
  // launched is never offered (mirrors the "Open with AI" menu).
  const selectableTargets = VISIBLE_TARGETS.filter(
    (target) => states[target.id]?.installed === true,
  );
  const probeSettled = VISIBLE_TARGETS.every((target) => states[target.id]?.installed != null);
  // Probe done with nothing installed → the composer has nothing to launch.
  const noAgentsInstalled = probeSettled && selectableTargets.length === 0;

  // Smart default: once the install probe settles, resolve last-used → first
  // installed → null (see `resolvePreferredAgent`). Gated on `userPickedRef` so
  // it never overrides a manual selection, and on the probe being fully resolved
  // so a partial result doesn't bounce the button mid-probe.
  useEffect(() => {
    if (!probeSettled || userPickedRef.current) return;
    const resolved = resolvePreferredAgent({ lastUsed: readPreferredAgent(), states });
    setSelectedAgentId((current) => (resolved === current ? current : resolved));
  }, [probeSettled, states]);

  function chooseAgent(targetId: HandoffTarget) {
    userPickedRef.current = true;
    setSelectedCli(null);
    setSelectedAgentId(targetId);
    writePreferredAgent(targetId);
  }

  // Select a docked-terminal CLI as the create target. Session-only; the Create
  // button performs the launch, parallel to chooseAgent setting the app default.
  function chooseCli(cli: TerminalCli) {
    userPickedRef.current = true;
    setSelectedCli(cli);
  }

  function launchCli() {
    if (terminalLaunch === null || selectedCli === null) return;
    const { instruction, mentions } = inputRef.current?.getContent() ?? {
      instruction: '',
      mentions: [],
    };
    // Require intent — no empty-brief launch (this surface carries no selection).
    // An empty attempt surfaces the requirement instead of silently no-op'ing.
    if (!hasValidPromptInput(instruction, mentions, false)) {
      setShowRequiredError(true);
      return;
    }
    const input = buildCreateHandoffInput({
      workspace,
      description: instruction,
      scenario,
      mentions,
    });
    if (input === null) return; // Workspace not resolved yet — disabled-trigger contract.
    terminalLaunch.launchInTerminal(input, selectedCli);
    // Clear the field + the SHARED draft so the handed-off brief doesn't linger
    // here or reappear in the bottom composer on the next doc navigation.
    inputRef.current?.clear();
    clearComposerDraft();
  }

  function handleCreate(targetId: HandoffTarget) {
    const { instruction, mentions } = inputRef.current?.getContent() ?? {
      instruction: '',
      mentions: [],
    };
    // Require intent before acting — an empty brief no longer degrades to a
    // generic "set up a new project" directive (this surface carries no
    // selection). An empty attempt surfaces the requirement instead of a
    // silent no-op.
    if (!hasValidPromptInput(instruction, mentions, false)) {
      setShowRequiredError(true);
      return;
    }
    // Remember what was launched so the next visit defaults to it.
    writePreferredAgent(targetId);
    const input = buildCreateHandoffInput({
      workspace,
      description: instruction,
      scenario,
      mentions,
    });
    if (input === null) return; // Workspace not resolved yet — disabled-trigger contract.
    void dispatch(targetId, input);
    // Clear the field + the SHARED draft so the handed-off brief doesn't linger
    // here or reappear in the bottom composer on the next doc navigation.
    inputRef.current?.clear();
    clearComposerDraft();
  }

  // Enter (handled inside ComposerMentionInput) creates with the resolved target
  // — the docked-terminal CLI when selected, else the chosen app agent. A null
  // agent (probe still settling) is a no-op, matching the disabled Create button.
  function handleSubmit() {
    if (cliSelected) {
      launchCli();
    } else if (selectedAgentId !== null) {
      handleCreate(selectedAgentId);
    }
  }

  // Prefill-only — drop the starter brief into the field and focus it so the
  // user can tweak before creating (matching the docs' "click any prompt to
  // copy it" affordance). Does NOT auto-dispatch. `setText` mirrors the resulting
  // doc into the shared draft itself, so a prefilled brief carries to the bottom
  // field without a separate store write here.
  function applySuggestion(prompt: string) {
    inputRef.current?.setText(prompt);
    inputRef.current?.focus();
  }

  // No agent to launch → the composer can't do anything, so collapse it to a
  // compact "install an agent" nudge instead of a dead input. Keeps the AI
  // capability discoverable + funnels to install, without the layout pop of
  // hiding the surface entirely.
  if (noAgentsInstalled) {
    return (
      <div
        className={cn(
          'flex w-full flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3',
          className,
        )}
        data-testid="create-no-agents"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Sparkles aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-1sm text-muted-foreground">
            <Trans>Install an AI agent to create with AI</Trans>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {VISIBLE_TARGETS.map((target) => (
            <Button
              key={target.id}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void openInstallUrl(target)}
              className="gap-1.5"
              data-testid={`install-agent-${target.id}`}
            >
              <TargetIcon id={target.id} aria-hidden="true" className="size-3.5" />
              {target.displayName}
              <ArrowUpRight aria-hidden="true" className="size-3" />
            </Button>
          ))}
        </div>
      </div>
    );
  }

  // Chevron-menu sections: installed app agents under "Desktop", the docked CLIs
  // under "Terminal". The separator sits between them only when both render.
  const showDesktopSection = selectableTargets.length > 0;
  const showTerminalSection = terminalLaunch !== null;

  return (
    <div className={cn('flex w-full flex-col gap-3', className)}>
      <div className="flex w-full flex-col rounded-2xl border border-border/60 bg-card shadow-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        {/* The card owns the border + focus ring; the mention input is bare (no
            border/ring of its own) so the whole card lights up on focus instead
            of nesting a second outline. The `@`-typeahead reuses the workspace
            doc/file corpus to insert reference chips. */}
        <ComposerMentionInput
          ref={inputRef}
          ariaLabel={t`Describe the project you want to create`}
          placeholder={t`A team knowledge base, a personal wiki, project docs...`}
          onEmptyChange={handleEmptyChange}
          onContentChange={setComposerDraftDoc}
          onSubmit={handleSubmit}
          initialDoc={initialDraftDoc}
          className="max-h-96 overflow-y-auto px-4 py-3 text-sm leading-relaxed subtle-scrollbar [&_.ProseMirror]:min-h-16"
        />
        {/* Footer row: the input-required validation error (left) + the Create
            split button (right). The error is hidden by default and only appears
            once the user attempts to create with an empty brief — rendered in the
            app's standard inline-validation style (role="alert" text-destructive,
            matching NewItemDialog). It clears as soon as a valid brief is typed. */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3">
          {showRequiredError && isEmpty ? (
            <p
              role="alert"
              className="text-1sm text-destructive"
              data-testid="create-input-required"
            >
              <Trans>Describe what you want to create to continue</Trans>
            </p>
          ) : (
            <span />
          )}
          {selectedAgentId === null ? (
            // No agent resolved yet (probe still settling) — nothing to launch.
            <Button
              type="button"
              variant="outline"
              disabled
              className="gap-1.5"
              data-testid="create-with-agent"
            >
              <Trans>Create</Trans>
            </Button>
          ) : (
            // ButtonGroup joins the corners and collapses the seam to a single
            // shared 1px border between the two outline buttons — that shared
            // border IS the divider, so no ButtonGroupSeparator.
            <ButtonGroup>
              <Button
                type="button"
                onClick={() => (cliSelected ? launchCli() : handleCreate(selectedAgentId))}
                variant="outline"
                className="gap-1.5"
                data-testid="create-with-agent"
              >
                {cliSelected && selectedCli !== null ? (
                  <>
                    <TargetIcon
                      id={cliIconTargetId(selectedCli)}
                      aria-hidden="true"
                      className="size-3.5"
                    />
                    <Trans>Create with {TERMINAL_CLIS[selectedCli].displayName} CLI</Trans>
                  </>
                ) : (
                  <>
                    <TargetIcon id={selectedAgentId} aria-hidden="true" className="size-3.5" />
                    <Trans>Create with {getDisplayNameDefault(selectedAgentId)}</Trans>
                  </>
                )}
              </Button>
              <DropdownMenu
                onOpenChange={(open) => {
                  if (open) void refresh();
                }}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    aria-label={t`Choose agent`}
                    size="icon"
                    variant="outline"
                    data-testid="create-with-agent-menu"
                  >
                    <ChevronDown aria-hidden="true" className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[200px]">
                  {showTerminalSection ? (
                    // Terminal section leads (the in-app terminal is the
                    // first-class path). Labeled `role="group"` so assistive tech
                    // announces the section the visual header conveys (the label
                    // alone is skipped by arrow-key menu navigation).
                    <DropdownMenuGroup aria-label={t`Terminal`}>
                      <DropdownMenuLabel>
                        <Trans>Terminal</Trans>
                      </DropdownMenuLabel>
                      {/* Selects a docked-terminal CLI as the create target (the
                        Create button performs the launch). Visible text is the
                        brand name while the accessible name is "<Brand> CLI" so AT
                        users can tell it apart from the matching Desktop row (WCAG
                        2.5.3 — the name contains the visible label). */}
                      {VISIBLE_CLIS.map((cli) => {
                        const { displayName } = TERMINAL_CLIS[cli];
                        return (
                          <DropdownMenuItem
                            key={cli}
                            onSelect={() => chooseCli(cli)}
                            data-testid={`create-with-cli-${cli}`}
                            aria-label={t`${displayName} CLI`}
                          >
                            <TargetIcon
                              id={cliIconTargetId(cli)}
                              aria-hidden="true"
                              className="size-4"
                            />
                            <span className="flex-1">{displayName}</span>
                            {selectedCli === cli ? (
                              <Check aria-hidden="true" className="size-4 text-muted-foreground" />
                            ) : null}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuGroup>
                  ) : null}
                  {showDesktopSection ? (
                    // Desktop app launchers follow the Terminal section.
                    <>
                      {showTerminalSection ? <DropdownMenuSeparator /> : null}
                      <DropdownMenuGroup aria-label={t`Desktop`}>
                        <DropdownMenuLabel>
                          <Trans>Desktop</Trans>
                        </DropdownMenuLabel>
                        {selectableTargets.map((target) => (
                          <DropdownMenuItem
                            key={target.id}
                            onSelect={() => chooseAgent(target.id)}
                            data-testid={`create-agent-option-${target.id}`}
                          >
                            <TargetIcon id={target.id} aria-hidden="true" className="size-4" />
                            <span className="flex-1">{target.displayName}</span>
                            {!cliSelected && target.id === selectedAgentId ? (
                              <Check aria-hidden="true" className="size-4 text-muted-foreground" />
                            ) : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </ButtonGroup>
          )}
        </div>
      </div>
      {/* Starter-brief chips — below the card, centered. Clicking one prefills
          the field (no auto-create), so they read as suggestions rather than
          card actions. Wraps on narrow widths. Suppressed for `existing-repo`:
          the repo's own contents are the starting point, so we don't pitch
          generic prefills there (the embedded copy-list still shows them). */}
      {scenario !== 'existing-repo' && suggestions.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="text-1sm text-muted-foreground">
            <Trans>Try a prompt</Trans>
          </span>
          {suggestions.map((suggestion) => {
            const Icon = suggestion.icon;
            return (
              <Button
                key={suggestion.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applySuggestion(suggestion.prompt)}
                className="gap-1.5 rounded-md font-normal text-muted-foreground hover:text-foreground"
                data-testid={`create-suggestion-${suggestion.id}`}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {suggestion.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
