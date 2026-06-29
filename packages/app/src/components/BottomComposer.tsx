
import {
  type TargetData,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, Loader2, TextQuote, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ComposerContextChips } from '@/components/ComposerContextChips';
import { AgentSplitButton } from '@/components/handoff/AgentSplitButton';
import { TargetIcon } from '@/components/handoff/OpenInAgentMenuItem';
import { useTerminalLaunch } from '@/components/handoff/TerminalLaunchContext';
import { cliIconTargetId } from '@/components/handoff/terminal-cli-display';
import {
  buildComposerHandoffInput,
  useHandoffDispatch,
} from '@/components/handoff/useHandoffDispatch';
import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
import { Button } from '@/components/ui/button';
import { getEditorForDoc } from '@/editor/active-editor';
import {
  ComposerMentionInput,
  type ComposerMentionInputHandle,
} from '@/editor/ComposerMentionInput';
import {
  lightRenderMarkdownPreview,
  type SelectionSnapshot,
  selectionChipLabel,
  selectionSnapshotToCompose,
} from '@/editor/selection-context';
import type { EditorSurface } from '@/editor/selection-stats';
import { useSelectionContext } from '@/hooks/use-selection-context';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import {
  loadStickyAgent,
  parseStickyCliId,
  resolveStickyAgent,
  saveStickyAgent,
  terminalCliId,
} from '@/lib/unified-agent-store';
import { useWorkspace } from '@/lib/use-workspace';
import { cn } from '@/lib/utils';
import { docNameToRelativePath } from '@/lib/workspace-paths';
import { emitOpenAskAiComposer, subscribeToOpenAskAiComposer } from './ask-ai-composer-events';
import { clearComposerDraft, getComposerDraft, setComposerDraftDoc } from './composer-draft-store';

const SUGGESTION_HOLD_MS = 5200; // fully-visible dwell per suggestion
const SUGGESTION_FADE_MS = 500; // cross-fade duration (matches the CSS duration)

function isNativeTextControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toUpperCase();
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
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
  /** Doc mode: the active doc. The host supplies exactly one of
   *  `docName` / `folderPath`. */
  docName?: string | null;
  /** The active edit surface, so the live selection is read from the visible
   *  editor (and source-mode selections can carry real line numbers). Doc mode
   *  only — folder mode has no editor surface. */
  surface?: EditorSurface;
  /** Folder mode: the active folder's workspace-relative path (forward-slash
   *  normalized, no trailing slash). When set, the composer is scoped to the
   *  folder — the folder is the top-row context chip AND the dispatch lead —
   *  instead of an open doc, and the doc-coupled affordances (selection passage,
   *  touched-file lifecycle, scroll-inset/caret machinery) are skipped. */
  folderPath?: string;
  /** When dismissed, the field collapses to nothing (the host shows a reopen
   *  badge in the footer); the component stays mounted so ⌘L can reopen it. Doc
   *  mode only — folder mode is always visible (no footer to dock a badge in). */
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
  const { states } = useInstalledAgents();
  const { dispatch } = useHandoffDispatch();
  const terminalLaunch = useTerminalLaunch();
  const [stickyId] = useState(() => loadStickyAgent());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<ComposerMentionInputHandle>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const [initialDraftDoc] = useState(() => getComposerDraft().doc ?? undefined);

  useEffect(() => {
    if (folderMode || docName == null) return;
    const root = document.documentElement;
    const followBottom = () => {
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
        const editor = getEditorForDoc(docName);
        const box = cardRef.current;
        if (!editor || editor.isDestroyed || !box) return;
        try {
          const view = editor.view; // throwing proxy before the PM view mounts
          const caret = view.coordsAtPos(editor.state.selection.head);
          const overlap = caret.bottom - (box.getBoundingClientRect().top - 28);
          if (overlap <= 0) return;
          const scroller = view.dom.closest('.editor-doc-scroll');
          if (scroller instanceof HTMLElement) scroller.scrollTop += overlap;
        } catch {
        }
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
      root.style.setProperty('--ask-composer-height', `${card.offsetHeight + 24}px`);
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
      if (isNativeTextControl(event.target)) return;
      event.preventDefault();
      emitOpenAskAiComposer();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (!dismissed) inputRef.current?.focus();
  }, [dismissed]);

  const [touchedFiles, setTouchedFiles] = useState<readonly string[]>([]);
  const [dismissedFiles, setDismissedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [inlineMentions, setInlineMentions] = useState<readonly string[]>([]);

  const activeFilePath = folderMode || docName == null ? '' : docNameToRelativePath(docName);
  useEffect(() => {
    if (folderMode || isEmpty) return;
    setTouchedFiles((prev) => {
      if (prev.includes(activeFilePath) || dismissedFiles.has(activeFilePath)) return prev;
      return [...prev, activeFilePath];
    });
  }, [folderMode, isEmpty, activeFilePath, dismissedFiles]);

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

  const effectiveId = selectedId ?? stickyId;
  const selectedCli: TerminalCli | null =
    terminalLaunch !== null ? parseStickyCliId(effectiveId) : null;
  const isTerminalSelected = selectedCli !== null;
  const resolvedTarget = isTerminalSelected ? null : resolveStickyAgent(states, effectiveId);

  const canSend =
    !pending &&
    (!isEmpty || pinnedSelection !== null) &&
    (isTerminalSelected || resolvedTarget !== null);

  const installedAgents = VISIBLE_TARGETS.filter((target) => states[target.id]?.installed === true);
  const agentProbePending = VISIBLE_TARGETS.some((target) => states[target.id]?.installed == null);

  const cliRows =
    terminalLaunch !== null
      ? TERMINAL_CLI_IDS.map((cli) => {
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

  const suggestions = [
    t`Research the extinction of flightless birds`,
    t`Condense my AGENTS.md file to less than 40k characters`,
    t`Create a new spec file for my user story`,
    t`Summarize everything I changed this week`,
  ];
  const suggestion = useRotatingSuggestion(suggestions, !reduced && isEmpty && !dismissed);

  const handleSelectAgent = (target: TargetData) => {
    setSelectedId(target.id);
    saveStickyAgent(target.id);
  };

  const handleSelectCli = (cli: TerminalCli) => {
    const id = terminalCliId(cli);
    setSelectedId(id);
    saveStickyAgent(id);
  };

  const clearComposer = () => {
    inputRef.current?.clear();
    setPinnedSelection(null);
    setSelectionExpanded(false);
    setTouchedFiles([]);
    setDismissedFiles(new Set());
    clearComposerDraft();
  };

  const dispatchComposed = (input: ReturnType<typeof buildComposerHandoffInput>) => {
    if (input === null) {
      toast.error(t`Couldn't send your prompt — please try again.`);
      return;
    }
    if (selectedCli !== null && terminalLaunch !== null) {
      try {
        terminalLaunch.launchInTerminal(input, selectedCli);
      } catch {
        toast.error(t`Couldn't open the terminal — please try again.`);
        return;
      }
      clearComposer();
      return;
    }
    if (resolvedTarget === null) return;
    setPending(true);
    void dispatch(resolvedTarget.id, input).finally(() => {
      setPending(false);
      clearComposer();
    });
  };

  const submit = () => {
    if (!canSend) return;
    const { instruction, mentions } = inputRef.current?.getContent() ?? {
      instruction: '',
      mentions: [],
    };

    if (folderMode) {
      const dispatchMentions = [...new Set([...fileChips, ...mentions])].filter(
        (path) => path !== folderPath,
      );
      dispatchComposed(
        buildComposerHandoffInput({
          docName: null,
          folderRelativePath: folderPath,
          workspace,
          instruction,
          mentions: dispatchMentions,
        }),
      );
      return;
    }

    const selection = pinnedSelection ? selectionSnapshotToCompose(pinnedSelection) : undefined;
    const selectionDoc = pinnedSelection?.docName ?? null;
    const leadDocName = pinnedSelection
      ? selectionDoc
      : fileChips.includes(activeFilePath)
        ? (docName ?? null)
        : null;
    const leadPath = leadDocName !== null ? docNameToRelativePath(leadDocName) : null;
    const dispatchMentions = [...new Set([...fileChips, ...mentions])].filter(
      (path) => path !== leadPath,
    );
    dispatchComposed(
      buildComposerHandoffInput({
        docName: leadDocName,
        workspace,
        instruction,
        mentions: dispatchMentions,
        selection,
      }),
    );
  };

  if (dismissed) return null;

  let pinnedLabel = '';
  let pinnedPreview = '';
  if (pinnedSelection) {
    const basename = docNameToRelativePath(pinnedSelection.docName).split('/').pop() ?? '';
    pinnedLabel = selectionChipLabel(pinnedSelection, basename);
    pinnedPreview = lightRenderMarkdownPreview(pinnedSelection.markdown);
  }

  const card = (
    <div
      ref={cardRef}
      className="pointer-events-auto group relative flex flex-col gap-1.5 rounded-2xl border border-border/60 bg-card px-3 py-2 shadow-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
    >
      {/* Collapse handle — a small tab centered above the card's top edge,
          revealed on hover/focus. Collapses the composer to the footer tab. Doc
          mode only: the folder view has no footer to dock a reopen badge into,
          so folder mode stays permanently expanded. */}
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
      {/* One wrapping context row. The removable file-context chips (files
          touched while drafting, minus dismissed / inline `@`-mentions; in
          folder mode the single chip is the folder scope) and the captured-
          selection pill are siblings in a single flex-wrap row, so they sit on
          the same line and only break to a second line on overflow. X'ing a file
          chip sticky-dismisses its path for this draft. The expanded selection
          preview carries `basis-full`, dropping onto its own line beneath the
          chips. */}
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
            {/* `title` recovers the full label once it ellipsis-truncates (mirrors
                the file chip's `title`). The cap sits a touch wider than the file
                chip's max-w-[14rem] because selection labels carry a `(range)`
                suffix. */}
            <span
              data-testid="composer-selection-pill"
              title={pinnedLabel}
              className="group/chip inline-flex max-w-[16rem] items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-1.5 pl-1 text-muted-foreground text-xs"
            >
              {/* The LEADING glyph IS the remove control (mirrors the file chip):
                  a fixed-size cell holding the selection's TextQuote glyph and an
                  X, cross-faded by opacity on chip hover / `:focus-within` / button
                  focus. The cell never resizes, so the pill box is identical at
                  rest vs hover → no reflow. TextQuote stays the at-rest icon (this
                  is a text selection). opacity only — never layout. */}
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
              {/* The chip label is compact (`name (range)`); clicking it peeks
                  the light-rendered preview (expand/collapse), Cursor-style. */}
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
      </ComposerContextChips>
      <div className="flex items-end gap-2">
        <div className="relative flex-1">
          <ComposerMentionInput
            ref={inputRef}
            ariaLabel={t`Ask AI`}
            onEmptyChange={setIsEmpty}
            onContentChange={setComposerDraftDoc}
            onMentionsChange={setInlineMentions}
            onSubmit={submit}
            initialDoc={initialDraftDoc}
            className="max-h-[200px] overflow-y-auto text-base md:text-sm"
          />
          {/* Animated placeholder overlay — decorative, so it's aria-hidden and
              the input keeps a stable accessible name. Aligns with the editor's
              text origin (py-1, text-base md:text-sm). */}
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
              {selectedCli !== null ? (
                <TargetIcon id={cliIconTargetId(selectedCli)} className="size-4" aria-hidden />
              ) : resolvedTarget ? (
                <TargetIcon id={resolvedTarget.id} className="size-4" aria-hidden />
              ) : null}
              <span>
                {selectedCli !== null ? (
                  <Trans>Ask {TERMINAL_CLIS[selectedCli].displayName} CLI</Trans>
                ) : resolvedTarget ? (
                  <Trans>Ask {resolvedTarget.displayName}</Trans>
                ) : (
                  <Trans>Ask</Trans>
                )}
              </span>
              {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            </>
          }
          onPrimary={submit}
          primaryDisabled={!canSend}
          installedTargets={installedAgents}
          selectedTargetId={isTerminalSelected ? null : (resolvedTarget?.id ?? null)}
          onSelectTarget={handleSelectAgent}
          terminals={cliRows}
          menuEmptyState={
            <p className="px-2 py-1.5 text-sm text-muted-foreground" aria-live="polite">
              {agentProbePending ? (
                <Trans>Checking for installed agents</Trans>
              ) : (
                <Trans>No installed agents found</Trans>
              )}
            </p>
          }
          triggerAriaLabel={t`Choose agent`}
          testIds={{
            primary: 'ask-ai-send',
            trigger: 'ask-ai-agent-trigger',
            menu: 'ask-ai-agent-menu',
            option: (id) => `ask-ai-agent-option-${id}`,
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
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 editor-content-aligned bg-gradient-to-t from-background from-65% via-background to-transparent pt-10 pb-2"
      data-testid="bottom-composer"
    >
      {card}
    </div>
  );
}
