import { type HandoffTarget, TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Check, ChevronDown, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
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
import {
  AskAgentNameLabel,
  DesktopAppName,
  OpenDesktopAppLabel,
} from '@/components/handoff/agent-launcher-labels';
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
  unresolvedDesktopTargets,
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

export function CreatePromptComposer({ scenario, className }: CreatePromptComposerProps) {
  const { t } = useLingui();
  const { states, refresh } = useInstalledAgents();
  const overrides = useEnabledOverrides();
  const { dispatch } = useHandoffDispatch();
  const workspace = useWorkspace();
  const terminalLaunch = useTerminalLaunch();

  const [selectedId, setSelectedId] = useState<string | null>(() => loadStickyAgent());

  const defaultRegisteredAgent = useDefaultRegisteredAgent();
  const registeredThreadAgents = useRegisteredAgents();
  const enabledThreadAgents = registeredThreadAgents.filter((agent) =>
    isInAppAgentEnabled(overrides, agent.source, agent.id, true, agent.supported),
  );
  const defaultThreadAgent = pickEffectiveDefaultAgent(enabledThreadAgents, defaultRegisteredAgent);

  const selection = resolveLauncherSelection({
    sticky: selectedId,
    effectiveThreadAgent: defaultThreadAgent,
    enabledClis:
      terminalLaunch !== null ? enabledTerminalClis(overrides, terminalLaunch.installedClis) : [],
    enabledDesktopTargets: enabledDesktopTargets(overrides, states),
    unresolvedDesktopTargets: unresolvedDesktopTargets(overrides, states),
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

  const [initialDraftDoc] = useState(() => getComposerDraft().doc ?? undefined);

  const [isEmpty, setIsEmpty] = useState(true);

  const [showRequiredError, setShowRequiredError] = useState(false);

  function handleEmptyChange(nextEmpty: boolean) {
    setIsEmpty(nextEmpty);
    if (!nextEmpty) setShowRequiredError(false);
  }

  const suggestions = useCreateSuggestions(scenario);

  const selectableTargets = VISIBLE_TARGETS.filter((target) =>
    isDesktopTargetEnabled(overrides, target.id, states[target.id]?.installed),
  );
  const probeSettled = VISIBLE_TARGETS.every((target) => states[target.id]?.installed != null);
  const hasEnabledTerminalCli =
    terminalLaunch !== null &&
    enabledTerminalClis(overrides, terminalLaunch.installedClis).length > 0;
  const noAgentsInstalled =
    probeSettled &&
    selectableTargets.length === 0 &&
    enabledThreadAgents.length === 0 &&
    !hasEnabledTerminalCli;

  function chooseAgent(targetId: HandoffTarget) {
    setSelectedId(targetId);
    saveStickyAgent(targetId);
    writePreferredAgent(targetId);
  }

  function chooseCli(cli: TerminalCli) {
    setSelectedId(terminalCliId(cli));
    saveStickyAgent(terminalCliId(cli));
  }

  function chooseThreadAgent(agent: RegisteredAgent) {
    registerAgent(agent);
    setSelectedId(IN_APP_THREAD_ID);
    saveStickyAgent(IN_APP_THREAD_ID);
  }

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
    terminalLaunch.launchInTerminal(input, selectedCli);
    inputRef.current?.clear();
    clearComposerDraft();
  }

  function handleCreate(targetId: HandoffTarget) {
    const { instruction, mentions } = inputRef.current?.getContent() ?? {
      instruction: '',
      mentions: [],
    };
    if (!hasValidPromptInput(instruction, mentions, false)) {
      setShowRequiredError(true);
      return;
    }
    writePreferredAgent(targetId);
    if (states[targetId]?.installed !== true) {
      const target = VISIBLE_TARGETS.find((candidate) => candidate.id === targetId);
      if (target) {
        void openInstallUrl(target);
        toast.info(t`${target.displayName} isn't installed yet — opening its download page.`);
      }
      return;
    }
    const input = buildCreateHandoffInput({
      workspace,
      description: instruction,
      scenario,
      mentions,
    });
    if (input === null) return;
    void dispatch(targetId, input);
    inputRef.current?.clear();
    clearComposerDraft();
  }

  function handleSubmit() {
    if (threadSelected) {
      launchThread();
    } else if (cliSelected) {
      launchCli();
    } else if (selectedAgentId !== null) {
      handleCreate(selectedAgentId);
    }
  }

  function applySuggestion(prompt: string) {
    inputRef.current?.setText(prompt);
    inputRef.current?.focus();
  }

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

  const terminalClis = terminalLaunch
    ? enabledTerminalClis(overrides, terminalLaunch.installedClis)
    : [];
  const showDesktopSection = selectableTargets.length > 0;
  const showTerminalSection = terminalClis.length > 0;
  const showThreadSection = enabledThreadAgents.length > 0;
  const canCreate = selection.kind !== 'none';

  return (
    <div className={cn('flex w-full flex-col gap-3', className)}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer clicks only delegate focus to the composer's editable; keyboard users focus it directly (Tab / ⌥⌘L). */}
      <div
        onMouseDown={(event) => focusComposerInputOnCardPointer(event, inputRef)}
        className="flex w-full cursor-text flex-col rounded-2xl border border-border/60 bg-card shadow-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
      >
        {}
        <ComposerMentionInput
          ref={inputRef}
          ariaLabel={
            scenario === 'skill'
              ? t`Describe the skill you want to create`
              : t`Describe the project you want to create`
          }
          placeholder={
            scenario === 'skill'
              ? t`A PR reviewer, a release-notes writer, a deploy checklist...`
              : t`A team knowledge base, a personal wiki, project docs...`
          }
          onEmptyChange={handleEmptyChange}
          onContentChange={setComposerDraftDoc}
          onSubmit={handleSubmit}
          initialDoc={initialDraftDoc}
          className="max-h-96 overflow-y-auto px-4 py-3 text-sm leading-relaxed subtle-scrollbar [&_.ProseMirror]:min-h-16"
        />
        {}
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
                    <AskAgentNameLabel agentName={defaultThreadAgent.name} />
                  </>
                ) : cliSelected && selectedCli !== null ? (
                  <>
                    <TargetIcon
                      id={cliIconTargetId(selectedCli)}
                      aria-hidden="true"
                      className="size-3.5"
                    />
                    <Trans>Ask {TERMINAL_CLIS[selectedCli].displayName} CLI</Trans>
                  </>
                ) : selectedAgentId !== null ? (
                  <>
                    <TargetIcon id={selectedAgentId} aria-hidden="true" className="size-3.5" />
                    <OpenDesktopAppLabel displayName={getDisplayNameDefault(selectedAgentId)} />
                    <ArrowUpRight aria-hidden="true" className="size-3.5" />
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
                  {}
                  {showThreadSection ? (
                    <DropdownMenuGroup aria-label={t`In app`}>
                      <DropdownMenuLabel>
                        <Trans>In app</Trans>
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
                    <DropdownMenuGroup aria-label={t`Terminal`}>
                      <DropdownMenuLabel>
                        <Trans>Terminal</Trans>
                      </DropdownMenuLabel>
                      {}
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
                    <>
                      {showTerminalSection ? <DropdownMenuSeparator /> : null}
                      <DropdownMenuGroup aria-label={t`External apps`}>
                        <DropdownMenuLabel className="flex items-center gap-1.5">
                          <Trans>External apps</Trans>
                          <ArrowUpRight aria-hidden="true" className="size-3" />
                        </DropdownMenuLabel>
                        {selectableTargets.map((target) => (
                          <DropdownMenuItem
                            key={target.id}
                            onSelect={() => chooseAgent(target.id)}
                            data-testid={`create-agent-option-${target.id}`}
                          >
                            <TargetIcon id={target.id} aria-hidden="true" className="size-4" />
                            <span className="flex-1">
                              <DesktopAppName displayName={target.displayName} />
                            </span>
                            {!cliSelected && target.id === selectedAgentId ? (
                              <Check aria-hidden="true" className="size-4 text-muted-foreground" />
                            ) : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </>
                  ) : null}
                  {}
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
      {}
      {scenario === 'new-project' && suggestions.length > 0 ? (
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
