// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { type TargetData, TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, ChevronDown, TextQuote, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  composeCommentBatchInstruction,
  QueuedCommentsChip,
  toCommentBatchItem,
  useSelectedCommentCount,
  useSelectedCommentDocs,
} from '@/comments/comment-chips';
import { type BatchPreparedItem, dispatchComments, subscribeCommentPosted } from '@/comments/store';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { ComposerContextChips } from '@/components/ComposerContextChips';
import { AgentSplitButton } from '@/components/handoff/AgentSplitButton';
import { AskAgentNameLabel, OpenDesktopAppLabel } from '@/components/handoff/agent-launcher-labels';
import { TargetIcon } from '@/components/handoff/OpenInAgentMenuItem';
import { useTerminalLaunch } from '@/components/handoff/TerminalLaunchContext';
import { cliIconTargetId } from '@/components/handoff/terminal-cli-display';
import {
  buildComposerHandoffInput,
  openInstallUrl,
  startAgentThreadForInput,
  useHandoffDispatch,
} from '@/components/handoff/useHandoffDispatch';
import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getEditorForDoc } from '@/editor/active-editor';
import {
  ComposerMentionInput,
  type ComposerMentionInputHandle,
} from '@/editor/ComposerMentionInput';
import { isScrollRestoreSuppressed } from '@/editor/scroll-restore-coordination';
import {
  lightRenderMarkdownPreview,
  type SelectionSnapshot,
  selectionChipLabel,
  selectionSnapshotToCompose,
} from '@/editor/selection-context';
import type { EditorSurface } from '@/editor/selection-stats';
import { useConflictComposerPrefill } from '@/hooks/use-conflict-composer-prefill';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useSelectionContext } from '@/hooks/use-selection-context';
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
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { recordOnboardingAskedAi } from '@/lib/onboarding-signals';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import {
  IN_APP_THREAD_ID,
  loadStickyAgent,
  saveStickyAgent,
  terminalCliId,
} from '@/lib/unified-agent-store';
import { openAgentSettings } from '@/lib/use-settings-route';
import { useWorkspace } from '@/lib/use-workspace';
import { cn } from '@/lib/utils';
import { docNameToRelativePath } from '@/lib/workspace-paths';
import { emitOpenAskAiComposer, subscribeToOpenAskAiComposer } from './ask-ai-composer-events';
import { clearComposerDraft, getComposerDraft, setComposerDraftDoc } from './composer-draft-store';
import { nextTouchedFiles } from './composer-touched-files';
import { focusComposerInputOnCardPointer } from './focus-composer-on-card-pointer';
import { usePageList } from './PageListContext';

const SUGGESTION_HOLD_MS = 5200;
const SUGGESTION_FADE_MS = 500;
const MARKDOWN_RELATIVE_PATH_EXTENSION = /\.(md|mdx)$/i;

function docNameToComposerRelativePath(docName: string, docExt?: string): string {
  if (MARKDOWN_RELATIVE_PATH_EXTENSION.test(docName)) return docName;
  return docExt ? `${docName}${docExt}` : docNameToRelativePath(docName);
}

function isNativeTextControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toUpperCase();
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

function useRotatingSuggestion(
  phrases: readonly string[],
  enabled: boolean,
): { text: string; visible: boolean } {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!enabled) return;
    if (visible) {
      const id = setTimeout(() => setVisible(false), SUGGESTION_HOLD_MS);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => {
      setIndex((i) => i + 1);
      setVisible(true);
    }, SUGGESTION_FADE_MS);
    return () => clearTimeout(id);
  }, [visible, enabled]);

  if (!enabled) return { text: phrases[0] ?? '', visible: true };
  const safeIndex = phrases.length > 0 ? index % phrases.length : 0;
  return { text: phrases[safeIndex] ?? '', visible };
}

export function BottomComposer({
  docName,
  surface,
  folderPath,
  dismissed = false,
  onDismiss,
  onReopen,
}: {
  docName?: string | null;
  surface?: EditorSurface;
  folderPath?: string;
  dismissed?: boolean;
  onDismiss?: () => void;
  onReopen?: () => void;
}) {
  const { t } = useLingui();
  const folderMode = folderPath !== undefined;
  const activeDocOrNull = folderMode ? null : (docName ?? null);
  const effectiveSurface: EditorSurface = surface ?? 'wysiwyg';
  const reduced = useReducedMotion();
  const workspace = useWorkspace();
  const { pageMeta } = usePageList();
  const { states, refresh: refreshInstalledAgents } = useInstalledAgents();
  const overrides = useEnabledOverrides();
  const { dispatch } = useHandoffDispatch();
  const terminalLaunch = useTerminalLaunch();
  const [stickyId] = useState(() => loadStickyAgent());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<ComposerMentionInputHandle>(null);
  const { isSeedIntact, onContentChanged: onPrefillContentChanged } = useConflictComposerPrefill(
    activeDocOrNull,
    inputRef,
  );
  const cardRef = useRef<HTMLDivElement>(null);

  const [initialDraftDoc] = useState(() => getComposerDraft().doc ?? undefined);

  useEffect(() => {
    if (folderMode || docName == null) return;
    const root = document.documentElement;
    const followBottom = () => {
      if (isScrollRestoreSuppressed(docName)) return;
      const pinned = [...document.querySelectorAll<HTMLElement>('.editor-doc-scroll')].filter(
        (el) => {
          const max = el.scrollHeight - el.clientHeight;
          return max > 0 && el.scrollTop >= max - 40;
        },
      );
      if (pinned.length === 0) return;
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
      };
      window.addEventListener('wheel', cancel, { passive: true });
      window.addEventListener('touchstart', cancel, { passive: true });
      const start = performance.now();
      const step = () => {
        if (isScrollRestoreSuppressed(docName)) cancelled = true;
        if (cancelled || performance.now() - start >= 300) {
          window.removeEventListener('wheel', cancel);
          window.removeEventListener('touchstart', cancel);
          return;
        }
        for (const el of pinned) el.scrollTop = el.scrollHeight - el.clientHeight;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    const revealCaret = () => {
      if (surface !== 'wysiwyg') return;
      requestAnimationFrame(() => {
        if (isScrollRestoreSuppressed(docName)) return;
        const editor = getEditorForDoc(docName);
        const box = cardRef.current;
        if (!editor || editor.isDestroyed || !box) return;
        try {
          const view = editor.view;
          const caret = view.coordsAtPos(editor.state.selection.head);
          const overlap = caret.bottom - (box.getBoundingClientRect().top - 28);
          if (overlap <= 0) return;
          const scroller = view.dom.closest('.editor-doc-scroll');
          if (scroller instanceof HTMLElement) scroller.scrollTop += overlap;
        } catch {}
      });
    };
    const card = cardRef.current;
    if (dismissed || !card) {
      followBottom();
      root.style.removeProperty('--ask-composer-height');
      return;
    }
    const apply = () => {
      followBottom();
      root.style.setProperty('--ask-composer-height', `${card.offsetHeight + 56}px`);
    };
    apply();
    revealCaret();
    const observer = new ResizeObserver(apply);
    observer.observe(card);
    return () => {
      observer.disconnect();
      followBottom();
      root.style.removeProperty('--ask-composer-height');
    };
  }, [dismissed, surface, docName, folderMode]);

  const dismissedRef = useRef(dismissed);
  const onReopenRef = useRef(onReopen);
  useEffect(() => {
    dismissedRef.current = dismissed;
    onReopenRef.current = onReopen;
  });

  useEffect(() => {
    const openAndFocus = () => {
      if (dismissedRef.current) onReopenRef.current?.();
      else inputRef.current?.focus();
    };
    return subscribeToOpenAskAiComposer(openAndFocus);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesKeyboardShortcut(event, 'open-ask-ai')) return;
      if (isOverlayLayerOpen()) return;
      if (isNativeTextControl(event.target)) return;
      event.preventDefault();
      emitOpenAskAiComposer();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  const prevDismissedRef = useRef(dismissed);
  useEffect(() => {
    const wasDismissed = prevDismissedRef.current;
    prevDismissedRef.current = dismissed;
    if (wasDismissed && !dismissed) inputRef.current?.focus();
  }, [dismissed]);

  const [touchedFiles, setTouchedFiles] = useState<readonly string[]>([]);
  const [dismissedFiles, setDismissedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const selectedCommentCount = useSelectedCommentCount();
  const selectedCommentDocs = useSelectedCommentDocs();
  const [commentsAttached, setCommentsAttached] = useState(true);
  const hasQueuedComments = selectedCommentCount > 0 && commentsAttached;
  const [inlineMentions, setInlineMentions] = useState<readonly string[]>([]);

  const activeFilePath =
    folderMode || docName == null
      ? ''
      : docNameToComposerRelativePath(docName, pageMeta.get(docName)?.docExt);
  useEffect(() => {
    if (folderMode || isEmpty) return;
    setTouchedFiles((prev) => nextTouchedFiles(prev, activeFilePath, dismissedFiles, isSeedIntact));
  }, [folderMode, isEmpty, isSeedIntact, activeFilePath, dismissedFiles]);

  const fileChips = folderMode
    ? folderPath && !dismissedFiles.has(folderPath) && !inlineMentions.includes(folderPath)
      ? [folderPath]
      : []
    : touchedFiles.filter((path) => !dismissedFiles.has(path) && !inlineMentions.includes(path));

  const liveSelection = useSelectionContext(activeDocOrNull, effectiveSurface);
  const liveFrontmatterSelection = useSelectionContext(activeDocOrNull, 'frontmatter');
  const [pinnedSelection, setPinnedSelection] = useState<SelectionSnapshot | null>(null);
  const [selectionExpanded, setSelectionExpanded] = useState(false);
  useEffect(() => {
    if (liveSelection) setPinnedSelection(liveSelection);
  }, [liveSelection]);
  useEffect(() => {
    if (liveFrontmatterSelection) setPinnedSelection(liveFrontmatterSelection);
  }, [liveFrontmatterSelection]);
  useEffect(
    () =>
      subscribeCommentPosted(() => {
        setPinnedSelection(null);
        setSelectionExpanded(false);
        setCommentsAttached(true);
      }),
    [],
  );

  const defaultRegisteredAgent = useDefaultRegisteredAgent();
  const registeredThreadAgents = useRegisteredAgents();
  const enabledThreadAgents = registeredThreadAgents.filter((agent) =>
    isInAppAgentEnabled(overrides, agent.source, agent.id, true, agent.supported),
  );
  const defaultThreadAgent = pickEffectiveDefaultAgent(enabledThreadAgents, defaultRegisteredAgent);

  const selection = resolveLauncherSelection({
    sticky: selectedId ?? stickyId,
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
  const isThreadSelected = selection.kind === 'thread';
  const selectedCli: TerminalCli | null = selection.kind === 'cli' ? selection.cli : null;
  const isTerminalSelected = selectedCli !== null;
  const resolvedTarget: TargetData | null =
    selection.kind === 'desktop'
      ? (VISIBLE_TARGETS.find((target) => target.id === selection.target) ?? null)
      : null;

  const canSend =
    !pending &&
    (!isEmpty || pinnedSelection !== null || hasQueuedComments) &&
    (isTerminalSelected || resolvedTarget !== null || isThreadSelected);

  const desktopAgents = VISIBLE_TARGETS.filter((target) =>
    isDesktopTargetEnabled(overrides, target.id, states[target.id]?.installed),
  );
  const agentProbePending = VISIBLE_TARGETS.some((target) => states[target.id]?.installed == null);

  const cliRows =
    terminalLaunch !== null
      ? enabledTerminalClis(overrides, terminalLaunch.installedClis).map((cli) => {
          const { displayName } = TERMINAL_CLIS[cli];
          return {
            cli,
            label: displayName,
            ariaLabel: t`${displayName} CLI`,
            selected: selectedCli === cli,
            onSelect: () => handleSelectCli(cli),
          };
        })
      : undefined;

  const suggestions = hasQueuedComments
    ? [t`Work through these comments`]
    : [
        t`Research the extinction of flightless birds`,
        t`Condense my AGENTS.md file to less than 40k characters`,
        t`Create a new spec file for my user story`,
        t`Summarize everything I changed this week`,
      ];
  const suggestion = useRotatingSuggestion(
    suggestions,
    !reduced && isEmpty && !dismissed && !hasQueuedComments,
  );

  const handleSelectAgent = (target: TargetData) => {
    setSelectedId(target.id);
    saveStickyAgent(target.id);
  };

  const handleSelectCli = (cli: TerminalCli) => {
    const id = terminalCliId(cli);
    setSelectedId(id);
    saveStickyAgent(id);
  };

  const handleSelectThread = () => {
    setSelectedId(IN_APP_THREAD_ID);
    saveStickyAgent(IN_APP_THREAD_ID);
  };

  const handleSelectThreadAgent = (agent: RegisteredAgent) => {
    registerAgent(agent);
    handleSelectThread();
  };

  const clearComposer = () => {
    inputRef.current?.clear();
    setPinnedSelection(null);
    setSelectionExpanded(false);
    setTouchedFiles([]);
    setDismissedFiles(new Set());
    setCommentsAttached(true);
    clearComposerDraft();
  };

  const dispatchComposed = async (
    input: ReturnType<typeof buildComposerHandoffInput>,
    clearOnSuccess = true,
  ): Promise<boolean> => {
    const clearIfOwned = () => {
      if (clearOnSuccess) clearComposer();
    };
    if (input === null) {
      toast.error(t`Couldn't send your prompt — please try again.`);
      return false;
    }
    if (isThreadSelected) {
      startAgentThreadForInput(
        input,
        defaultThreadAgent !== null
          ? { agent: { source: defaultThreadAgent.source, id: defaultThreadAgent.id } }
          : undefined,
      );
      recordOnboardingAskedAi();
      clearIfOwned();
      return true;
    }
    if (selectedCli !== null && terminalLaunch !== null) {
      try {
        terminalLaunch.launchInTerminal(input, selectedCli);
      } catch {
        toast.error(t`Couldn't open the terminal — please try again.`);
        return false;
      }
      recordOnboardingAskedAi();
      clearIfOwned();
      return true;
    }
    if (resolvedTarget === null) {
      toast.error(t`No agent is set up yet — pick one from the send menu.`);
      return false;
    }
    if (states[resolvedTarget.id]?.installed !== true) {
      void openInstallUrl(resolvedTarget);
      toast.info(t`${resolvedTarget.displayName} isn't installed yet — opening its download page.`);
      clearIfOwned();
      return false;
    }
    setPending(true);
    const outcome = await dispatch(resolvedTarget.id, input).finally(() => {
      setPending(false);
      clearIfOwned();
    });
    if (outcome.ok) recordOnboardingAskedAi();
    return outcome.ok;
  };

  const composeCurrentInput = () => {
    const { instruction, mentions } = inputRef.current?.getContent() ?? {
      instruction: '',
      mentions: [],
    };

    if (folderMode) {
      const dispatchMentions = [...new Set([...fileChips, ...mentions])].filter(
        (path) => path !== folderPath,
      );
      return buildComposerHandoffInput({
        docName: null,
        folderRelativePath: folderPath,
        workspace,
        instruction,
        mentions: dispatchMentions,
      });
    }

    const selection = pinnedSelection ? selectionSnapshotToCompose(pinnedSelection) : undefined;
    const selectionDoc = pinnedSelection?.docName ?? null;
    const leadDocName = pinnedSelection
      ? selectionDoc
      : fileChips.includes(activeFilePath)
        ? (docName ?? null)
        : null;
    const leadPath =
      leadDocName !== null
        ? docNameToComposerRelativePath(leadDocName, pageMeta.get(leadDocName)?.docExt)
        : null;
    const dispatchMentions = [...new Set([...fileChips, ...mentions])].filter(
      (path) => path !== leadPath,
    );
    return buildComposerHandoffInput({
      docName: leadDocName,
      ...(leadPath !== null ? { docRelativePath: leadPath } : {}),
      workspace,
      instruction,
      mentions: dispatchMentions,
      selection,
    });
  };

  const submit = () => {
    if (!canSend) return;
    if (hasQueuedComments) {
      submitQueuedComments().catch((err) => {
        console.warn('[comments] queued-comment send rejected unexpectedly', err);
      });
      return;
    }
    void dispatchComposed(composeCurrentInput());
  };

  const submitQueuedComments = async () => {
    const { instruction, mentions } = inputRef.current?.getContent() ?? {
      instruction: '',
      mentions: [],
    };
    const shipped = await dispatchComments({
      compose: async (items: readonly BatchPreparedItem[]) => {
        const input = buildComposerHandoffInput({
          docName: null,
          workspace,
          instruction: composeCommentBatchInstruction(
            items.map((item) => toCommentBatchItem(item.payload)),
            instruction,
            pinnedSelection
              ? { docName: pinnedSelection.docName, markdown: pinnedSelection.markdown }
              : undefined,
          ),
          mentions: [
            ...new Set([
              ...items.map((item) => docNameToRelativePath(item.payload.docName)),
              ...fileChips,
              ...mentions,
            ]),
          ],
        });
        if (input === null) {
          toast.error(t`Couldn't send your comments — please try again.`);
          return false;
        }
        return dispatchComposed(input, false);
      },
    });
    if (shipped.length > 0) clearComposer();
  };

  if (dismissed) return null;

  let pinnedLabel = '';
  let pinnedPreview = '';
  if (pinnedSelection) {
    const basename =
      docNameToComposerRelativePath(
        pinnedSelection.docName,
        pageMeta.get(pinnedSelection.docName)?.docExt,
      )
        .split('/')
        .pop() ?? '';
    pinnedLabel = selectionChipLabel(pinnedSelection, basename);
    pinnedPreview = lightRenderMarkdownPreview(pinnedSelection.markdown);
  }

  const card = (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer clicks only delegate focus to the composer's editable; keyboard users focus it directly (Tab / ⇧⌘L).
    <div
      ref={cardRef}
      onMouseDown={(event) => focusComposerInputOnCardPointer(event, inputRef)}
      className="pointer-events-auto group relative flex cursor-text flex-col gap-1.5 rounded-2xl border border-border/60 bg-card px-3 py-2 shadow-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
    >
      {}
      {!folderMode ? (
        <Button
          type="button"
          variant="outline"
          aria-label={t`Collapse Ask AI`}
          onClick={() => onDismiss?.()}
          data-testid="ask-ai-collapse"
          className="-top-2.5 -translate-x-1/2 absolute left-1/2 z-10 h-5 w-10 rounded-md p-0 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
        >
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      ) : null}
      {}
      <ComposerContextChips
        files={fileChips}
        onRemoveFile={(path) =>
          setDismissedFiles((prev) => {
            const next = new Set(prev);
            next.add(path);
            return next;
          })
        }
      >
        {pinnedSelection ? (
          <>
            {}
            <span
              data-testid="composer-selection-pill"
              title={pinnedLabel}
              className="group/chip inline-flex max-w-[16rem] items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-1.5 pl-1 text-muted-foreground text-xs"
            >
              {}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t`Remove selection`}
                onClick={() => {
                  setPinnedSelection(null);
                  setSelectionExpanded(false);
                }}
                className="group/remove relative size-3.5 shrink-0 rounded-sm text-muted-foreground/80 hover:text-foreground"
              >
                <TextQuote
                  className="absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 opacity-100 transition-opacity duration-150 ease-out group-hover/chip:opacity-0 group-focus-within/chip:opacity-0 motion-reduce:transition-none"
                  aria-hidden
                />
                <X
                  className="absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 ease-out group-hover/chip:opacity-100 group-focus-within/chip:opacity-100 motion-reduce:transition-none"
                  aria-hidden
                />
              </Button>
              {}
              <Button
                type="button"
                variant="ghost"
                aria-expanded={selectionExpanded}
                aria-label={
                  selectionExpanded ? t`Hide selection preview` : t`Show selection preview`
                }
                onClick={() => setSelectionExpanded((open) => !open)}
                data-testid="composer-selection-peek"
                className="h-auto min-h-0 min-w-0 shrink justify-start px-0 py-0 text-left font-normal text-muted-foreground text-xs hover:bg-transparent hover:text-foreground"
              >
                <span className="min-w-0 truncate">{pinnedLabel}</span>
              </Button>
            </span>
            {selectionExpanded && pinnedPreview !== '' ? (
              <p
                className="max-h-24 w-full basis-full overflow-y-auto whitespace-pre-wrap text-2xs text-muted-foreground/80 subtle-scrollbar"
                data-testid="composer-selection-preview"
              >
                {pinnedPreview}
              </p>
            ) : null}
          </>
        ) : null}
        {}
        {selectedCommentCount > 0 && (
          <QueuedCommentsChip
            count={selectedCommentCount}
            docs={selectedCommentDocs}
            attached={commentsAttached}
            onAttach={() => setCommentsAttached(true)}
            onDismiss={() => setCommentsAttached(false)}
          />
        )}
      </ComposerContextChips>
      <div className="flex items-end gap-2">
        <div className="relative flex-1">
          <ComposerMentionInput
            ref={inputRef}
            ariaLabel={t`Ask AI`}
            onEmptyChange={setIsEmpty}
            onContentChange={(doc) => {
              setComposerDraftDoc(doc);
              onPrefillContentChanged();
            }}
            onMentionsChange={setInlineMentions}
            onSubmit={submit}
            initialDoc={initialDraftDoc}
            className="max-h-[200px] overflow-y-auto text-base md:text-sm"
          />
          {}
          {isEmpty ? (
            <div
              aria-hidden
              className={cn(
                'pointer-events-none absolute inset-0 truncate px-0 py-1 text-base text-muted-foreground/60 md:text-sm',
                !reduced && 'transition-opacity duration-500 ease-in-out',
                suggestion.visible ? 'opacity-100' : 'opacity-0',
              )}
            >
              {suggestion.text}
            </div>
          ) : null}
        </div>
        <AgentSplitButton
          primary={
            <>
              {isThreadSelected ? (
                <RegisteredAgentIcon
                  agentId={defaultThreadAgent?.id ?? ''}
                  iconUrl={defaultThreadAgent?.iconUrl}
                  className="size-4"
                />
              ) : selectedCli !== null ? (
                <TargetIcon id={cliIconTargetId(selectedCli)} className="size-4" aria-hidden />
              ) : resolvedTarget ? (
                <TargetIcon id={resolvedTarget.id} className="size-4" aria-hidden />
              ) : null}
              <span>
                {isThreadSelected ? (
                  defaultThreadAgent !== null ? (
                    <AskAgentNameLabel agentName={defaultThreadAgent.name} />
                  ) : (
                    <Trans>Ask an agent</Trans>
                  )
                ) : selectedCli !== null ? (
                  <Trans>Ask {TERMINAL_CLIS[selectedCli].displayName} CLI</Trans>
                ) : resolvedTarget ? (
                  <OpenDesktopAppLabel displayName={resolvedTarget.displayName} />
                ) : (
                  <Trans>Ask</Trans>
                )}
              </span>
              {}
              {resolvedTarget ? <ArrowUpRight aria-hidden className="size-3.5" /> : null}
              {pending ? <Spinner className="size-3.5" aria-hidden /> : null}
            </>
          }
          onPrimary={submit}
          primaryDisabled={!canSend}
          enabledTargets={desktopAgents}
          selectedTargetId={isTerminalSelected ? null : (resolvedTarget?.id ?? null)}
          onSelectTarget={handleSelectAgent}
          threadAgents={enabledThreadAgents.map((agent) => ({
            key: `${agent.source}:${agent.id}`,
            id: agent.id,
            name: agent.name,
            ...(agent.iconUrl !== undefined ? { iconUrl: agent.iconUrl } : {}),
            selected:
              isThreadSelected &&
              defaultThreadAgent !== null &&
              defaultThreadAgent.source === agent.source &&
              defaultThreadAgent.id === agent.id,
            onSelect: () => handleSelectThreadAgent(agent),
          }))}
          onOpenSettings={openAgentSettings}
          onMenuOpenChange={(open) => {
            if (open) void refreshInstalledAgents();
          }}
          terminals={cliRows}
          menuEmptyState={
            <p className="px-2 py-1.5 text-sm text-muted-foreground" aria-live="polite">
              {agentProbePending ? (
                <Trans>Checking for agents</Trans>
              ) : (
                <Trans>No agents enabled</Trans>
              )}
            </p>
          }
          triggerAriaLabel={t`Choose agent`}
          testIds={{
            primary: 'ask-ai-send',
            trigger: 'ask-ai-agent-trigger',
            menu: 'ask-ai-agent-menu',
            option: (id) => `ask-ai-agent-option-${id}`,
            threadAgent: (key) => `ask-ai-agent-option-thread-${key}`,
            settings: 'ask-ai-agent-option-settings',
            terminal: (cli) =>
              cli === 'claude'
                ? 'ask-ai-agent-option-terminal'
                : `ask-ai-agent-option-terminal-${cli}`,
          }}
        />
      </div>
    </div>
  );

  if (folderMode) {
    return (
      <div className="shrink-0 pt-2 pb-3" data-testid="bottom-composer">
        <div className="mx-auto w-full max-w-4xl px-6">{card}</div>
      </div>
    );
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-[var(--conflict-footer-height,0px)] z-20 editor-content-aligned bg-gradient-to-t from-background from-65% via-background to-transparent pt-10 pb-2"
      data-testid="bottom-composer"
    >
      {card}
    </div>
  );
}
