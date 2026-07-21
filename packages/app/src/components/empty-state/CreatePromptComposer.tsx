import { type HandoffTarget, TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, ChevronDown, SlidersHorizontal, Sparkles } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { AgentBetaBadge } from '@/components/acp/AgentBetaBadge';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraftDoc,
} from '@/components/composer-draft-store';
import {
  type CreateScenario,
  useCreateSuggestions,
} from '@/components/empty-state/use-create-suggestions';
import { focusComposerInputOnCardPointer } from '@/components/focus-composer-on-card-pointer';
import { TargetIcon } from '@/components/handoff/OpenInAgentMenuItem';
import { useTerminalLaunch } from '@/components/handoff/TerminalLaunchContext';
import { cliIconTargetId } from '@/components/handoff/terminal-cli-display';
import {
  buildCreateHandoffInput,
  getDisplayNameDefault,
  openInstallUrl,
  startAgentThreadForInput,
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
import { isDesktopTargetEnabled, isInAppAgentEnabled } from '@/lib/acp/agent-visibility';
import { useEnabledOverrides } from '@/lib/acp/enabled-agents';
import {
  enabledDesktopTargets,
  enabledTerminalClis,
  resolveLauncherSelection,
} from '@/lib/acp/launcher-selection';
import {
  pickEffectiveDefaultAgent,
  type RegisteredAgent,
  registerAgent,
  useDefaultRegisteredAgent,
  useRegisteredAgents,
} from '@/lib/acp/registered-agents';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { hasValidPromptInput } from '@/lib/has-valid-prompt-input';
import { writePreferredAgent } from '@/lib/preferred-agent-store';
import {
  IN_APP_THREAD_ID,
  loadStickyAgent,
  saveStickyAgent,
  terminalCliId,
} from '@/lib/unified-agent-store';
import { openAgentSettings } from '@/lib/use-settings-route';
import { useWorkspace } from '@/lib/use-workspace';
import { cn } from '@/lib/utils';

interface CreatePromptComposerProps {
  readonly scenario: CreateScenario;
  readonly className?: string;
}

/**
 * "Start {agentName}" with the named placeholder — keeps the catalog message
 * shared with the launcher menus' t-macro form (`t\`Start ${agentName}\``);
 * inlining a member expression would emit a positional `{0}` and fork it.
 */
function StartAgentNameLabel({ agentName }: { agentName: string }): ReactNode {
  return <Trans>Start {agentName}</Trans>;
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
  const overrides = useEnabledOverrides();
  const { dispatch } = useHandoffDispatch();
  const workspace = useWorkspace();
  // Null on the web host (no docked terminal); non-null only on desktop. Gates
  // the chevron menu's "Terminal" launch section.
  const terminalLaunch = useTerminalLaunch();

  // The remembered pick as reactive session state — a unified-agent-store sticky
  // id, seeded from device-local memory and updated by the picks below. The
  // effective SELECTION is DERIVED from it every render (never snapshotted at
  // mount), so enabling/disabling agents in Settings takes effect immediately.
  const [selectedId, setSelectedId] = useState<string | null>(() => loadStickyAgent());

  const defaultRegisteredAgent = useDefaultRegisteredAgent();
  // Every registered agent gets a picker row; only the ENABLED ones show.
  const registeredThreadAgents = useRegisteredAgents();
  const enabledThreadAgents = registeredThreadAgents.filter((agent) =>
    isInAppAgentEnabled(overrides, agent.source, agent.id, true, agent.supported),
  );
  // The in-app agent the primary launches + names: the registered default when
  // still enabled, else the first enabled one.
  const defaultThreadAgent = pickEffectiveDefaultAgent(enabledThreadAgents, defaultRegisteredAgent);

  // One selection decision, enablement-aware for every category — the SAME
  // `resolveLauncherSelection` the footer composer + sessions dock use, so a
  // disabled agent / CLI / app is never the Create target on any surface.
  const selection = resolveLauncherSelection({
    sticky: selectedId,
    effectiveThreadAgent: defaultThreadAgent,
    enabledClis:
      terminalLaunch !== null ? enabledTerminalClis(overrides, terminalLaunch.installedClis) : [],
    enabledDesktopTargets: enabledDesktopTargets(overrides),
    installedClis: terminalLaunch?.installedClis ?? {},
    terminalAvailable: terminalLaunch !== null,
    threadsAvailable: true,
    desktopSelectable: true,
  });
  const threadSelected = selection.kind === 'thread';
  const selectedCli: TerminalCli | null = selection.kind === 'cli' ? selection.cli : null;
  const selectedAgentId: HandoffTarget | null =
    selection.kind === 'desktop' ? selection.target : null;
  const cliSelected = selectedCli !== null;

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

  // Desktop rows are the agents the user ENABLED in Configure agents (Desktop is
  // off by default; enabling is opt-in). An enabled-but-not-installed agent
  // still shows and routes to its installer on Create.
  const selectableTargets = VISIBLE_TARGETS.filter((target) =>
    isDesktopTargetEnabled(overrides, target.id),
  );
  const probeSettled = VISIBLE_TARGETS.every((target) => states[target.id]?.installed != null);
  const hasEnabledTerminalCli =
    terminalLaunch !== null &&
    enabledTerminalClis(overrides, terminalLaunch.installedClis).length > 0;
  // Collapse to the install nudge only when the user has nothing enabled at all
  // (in-app agents are seeded on by default, so this is rare). Otherwise the
  // composer defaults to in-app thread mode.
  const noAgentsInstalled =
    probeSettled &&
    selectableTargets.length === 0 &&
    enabledThreadAgents.length === 0 &&
    !hasEnabledTerminalCli;

  // Every pick just updates the one sticky id (persisted + reactive); the
  // selection re-derives above. No probe-reconcile effect and no `userPickedRef`
  // — an explicit pick simply wins because it IS the sticky value, and a stale
  // pick (a disabled agent/CLI/app) degrades through `resolveLauncherSelection`.
  function chooseAgent(targetId: HandoffTarget) {
    setSelectedId(targetId);
    saveStickyAgent(targetId);
    writePreferredAgent(targetId); // legacy key, kept for cross-surface back-compat
  }

  function chooseCli(cli: TerminalCli) {
    setSelectedId(terminalCliId(cli));
    saveStickyAgent(terminalCliId(cli));
  }

  // Picking a specific registered agent makes it the launch default and selects
  // in-app thread mode.
  function chooseThreadAgent(agent: RegisteredAgent) {
    registerAgent(agent);
    setSelectedId(IN_APP_THREAD_ID);
    saveStickyAgent(IN_APP_THREAD_ID);
  }

  // Open a server-hosted in-app agent thread with the composed brief, mirroring
  // handleCreate's validation + draft-clear. No deep-link dispatch.
  function launchThread() {
    const { instruction, mentions } = inputRef.current?.getContent() ?? {
      instruction: '',
      mentions: [],
    };
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
    if (input === null) return;
    // Launch the effective (enabled) agent explicitly, never a disabled default.
    startAgentThreadForInput(
      input,
      defaultThreadAgent !== null
        ? { agent: { source: defaultThreadAgent.source, id: defaultThreadAgent.id } }
        : undefined,
    );
    inputRef.current?.clear();
    clearComposerDraft();
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
    // An enabled-but-not-installed Desktop agent routes to its installer
    // rather than a failing deep-link dispatch.
    if (states[targetId]?.installed !== true) {
      const target = VISIBLE_TARGETS.find((candidate) => candidate.id === targetId);
      if (target) void openInstallUrl(target);
      return;
    }
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

  // Enter (handled inside ComposerMentionInput) must perform the SAME action as
  // the primary Create button so keyboard and pointer never diverge: launch the
  // in-app agent thread when thread mode is selected, else the docked-terminal
  // CLI, else the chosen app agent. The branch ORDER mirrors the button's onClick
  // (thread → CLI → app agent). A null agent with none of those selected (probe
  // still settling) is a no-op, matching the disabled Create button.
  function handleSubmit() {
    if (threadSelected) {
      launchThread();
    } else if (cliSelected) {
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

  // Nothing enabled to launch → the composer can't do anything, so collapse it
  // to a compact nudge that points at Configure agents instead of a dead input.
  // We no longer pitch desktop-app installs here: Desktop is opt-in and the
  // in-app agents are the first-class path, so "turn one on" is the honest CTA.
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
            <Trans>Turn on an agent to create with AI</Trans>
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={openAgentSettings}
          className="gap-1.5"
          data-testid="create-configure-agents"
        >
          <SlidersHorizontal aria-hidden="true" className="size-3.5" />
          <Trans>Configure agents</Trans>
        </Button>
      </div>
    );
  }

  // Chevron-menu sections. Each renders only when it has rows, so an empty
  // section header never shows. The Terminal CLIs are the ones enabled in
  // Configure agents.
  const terminalClis = terminalLaunch
    ? enabledTerminalClis(overrides, terminalLaunch.installedClis)
    : [];
  const showDesktopSection = selectableTargets.length > 0;
  const showTerminalSection = terminalClis.length > 0;
  const showThreadSection = enabledThreadAgents.length > 0;
  // The Create button is actionable whenever the resolver found something enabled
  // to launch (an in-app thread, a CLI, or a picked desktop app).
  const canCreate = selection.kind !== 'none';

  return (
    <div className={cn('flex w-full flex-col gap-3', className)}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer clicks only delegate focus to the composer's editable; keyboard users focus it directly (Tab / ⌘L). */}
      <div
        // Click anywhere in the card's whitespace (the padding around the input,
        // the footer row beside the Create button) focuses the field — the
        // standard chat-composer affordance. Presses on the Create split button /
        // chips / editable are left alone. See focus-composer-on-card-pointer.ts.
        onMouseDown={(event) => focusComposerInputOnCardPointer(event, inputRef)}
        className="flex w-full cursor-text flex-col rounded-2xl border border-border/60 bg-card shadow-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
      >
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
          {!canCreate ? (
            // Nothing enabled to launch yet — a disabled affordance.
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
                onClick={() =>
                  threadSelected
                    ? launchThread()
                    : cliSelected
                      ? launchCli()
                      : selectedAgentId !== null
                        ? handleCreate(selectedAgentId)
                        : undefined
                }
                variant="outline"
                className="gap-1.5"
                data-testid="create-with-agent"
              >
                {threadSelected && defaultThreadAgent !== null ? (
                  <>
                    <RegisteredAgentIcon
                      agentId={defaultThreadAgent.id}
                      iconUrl={defaultThreadAgent.iconUrl}
                      className="size-3.5"
                    />
                    <StartAgentNameLabel agentName={defaultThreadAgent.name} />
                  </>
                ) : cliSelected && selectedCli !== null ? (
                  <>
                    <TargetIcon
                      id={cliIconTargetId(selectedCli)}
                      aria-hidden="true"
                      className="size-3.5"
                    />
                    <Trans>Create with {TERMINAL_CLIS[selectedCli].displayName} CLI</Trans>
                  </>
                ) : selectedAgentId !== null ? (
                  <>
                    <TargetIcon id={selectedAgentId} aria-hidden="true" className="size-3.5" />
                    <Trans>Create with {getDisplayNameDefault(selectedAgentId)}</Trans>
                  </>
                ) : null}
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
                <DropdownMenuContent align="end" className="max-h-80 min-w-[200px]">
                  {/* In-app agent threads lead the menu when any is enabled;
                      an empty section (all disabled) is hidden entirely. */}
                  {showThreadSection ? (
                    <DropdownMenuGroup aria-label={t`In app (beta)`}>
                      <DropdownMenuLabel className="flex items-center gap-1.5">
                        <Trans>In app</Trans>
                        <AgentBetaBadge />
                      </DropdownMenuLabel>
                      {enabledThreadAgents.map((agent) => (
                        <DropdownMenuItem
                          key={`${agent.source}:${agent.id}`}
                          onSelect={() => chooseThreadAgent(agent)}
                          data-testid={`create-agent-option-thread-${agent.source}:${agent.id}`}
                        >
                          <RegisteredAgentIcon
                            agentId={agent.id}
                            iconUrl={agent.iconUrl}
                            className="size-4"
                          />
                          <span className="flex-1 truncate">{agent.name}</span>
                          {threadSelected &&
                          defaultThreadAgent !== null &&
                          defaultThreadAgent.source === agent.source &&
                          defaultThreadAgent.id === agent.id ? (
                            <Check aria-hidden="true" className="size-4 text-muted-foreground" />
                          ) : null}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  ) : null}
                  {showThreadSection && (showTerminalSection || showDesktopSection) ? (
                    <DropdownMenuSeparator />
                  ) : null}
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
                      {terminalClis.map((cli) => {
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
                  {/* Settings row — always last. Opens Configure agents so the
                      user manages which agents appear here (replaces the former
                      "Choose another agent" catalog affordance). */}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={openAgentSettings}
                    data-testid="create-agent-option-settings"
                  >
                    <SlidersHorizontal
                      aria-hidden="true"
                      className="size-4 text-muted-foreground"
                    />
                    <span className="flex-1">
                      <Trans>Configure agents</Trans>
                    </span>
                  </DropdownMenuItem>
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
