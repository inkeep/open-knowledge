/**
 * "Ask AI" composer docked as a slim single-line field above the editor
 * footer. Mounted in two modes (`bottom-composer-gate.ts` holds both
 * predicates): for the open doc via `shouldShowBottomComposer` — desktop app
 * and browser alike, hidden while the docked terminal owns the bottom of the
 * column and inside embedded AI webviews — and by the folder overview via
 * `shouldShowFolderComposer` (same gates, no doc-open requirement). In doc
 * mode it renders as an absolute overlay and the editor content is inset by
 * `--ask-composer-height`; in folder mode it is an in-flow field below the
 * folder list.
 *
 * A short, single-line input at rest that auto-grows as the instruction spans
 * multiple lines, wrapped in a rounded card that owns the focus ring. It
 * carries a segmented "Ask <agent>" send control (the shared
 * `AgentSplitButton`: primary submit + joined agent-picker chevron), a
 * rotating-suggestion placeholder that cross-fades between prompts while
 * empty, and the ⇧⌘L focus shortcut.
 *
 * Submitting dispatches the typed instruction to the resolved default agent
 * (first installed, or the user's sticky pick) scoped to the current doc or
 * folder, via the shared handoff plumbing (`useHandoffDispatch` -> ask-scope
 * input -> `composeAskPrompt`). Picking a Terminal CLI (any `TerminalCli`)
 * hands the composed prompt to the docked terminal instead
 * of a deep-link dispatch — always in a new terminal tab (reusing a live
 * shell is exclusively the selection-bubble path).
 */

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
import { focusComposerInputOnCardPointer } from './focus-composer-on-card-pointer';
import { usePageList } from './PageListContext';

// Each suggestion holds long enough to read, then cross-fades to the next.
const SUGGESTION_HOLD_MS = 5200; // fully-visible dwell per suggestion
const SUGGESTION_FADE_MS = 500; // cross-fade duration (matches the CSS duration)
const MARKDOWN_RELATIVE_PATH_EXTENSION = /\.(md|mdx)$/i;

function docNameToComposerRelativePath(docName: string, docExt?: string): string {
  if (MARKDOWN_RELATIVE_PATH_EXTENSION.test(docName)) return docName;
  return docExt ? `${docName}${docExt}` : docNameToRelativePath(docName);
}

function markdownRelativePathStem(path: string): string | null {
  return MARKDOWN_RELATIVE_PATH_EXTENSION.test(path)
    ? path.replace(MARKDOWN_RELATIVE_PATH_EXTENSION, '')
    : null;
}

/**
 * Whether a keydown originated inside a native form field. ⇧⌘L should still fire
 * from the ProseMirror body (a contentEditable root), so this is deliberately
 * NARROWER than `isEditableShortcutTarget` — only native INPUT/TEXTAREA/SELECT
 * are excluded, so ⇧⌘L never steals a caret out of a real form field (e.g. the
 * rename input, a search box).
 */
function isNativeTextControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toUpperCase();
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

/**
 * Rotates through `phrases`, holding each one long enough to read, then fading
 * it out and the next one in. `enabled === false` (reduced motion, or a
 * non-empty field) pins the first phrase, fully visible and static. Derived
 * purely from state + the `phrases` prop so React Compiler is happy; the
 * effects key on the phrase index, not array identity, so a fresh array each
 * render is harmless.
 */
function useRotatingSuggestion(
  phrases: readonly string[],
  enabled: boolean,
): { text: string; visible: boolean } {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  // Drive the rotation off `visible`: hold the phrase, fade it out, then advance
  // and fade the next one in. Kept as one effect so its dependencies are exactly
  // the values it reads (`visible`, `enabled`) — the setState updaters are stable.
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
   *  badge in the footer); the component stays mounted so ⇧⌘L can reopen it. Doc
   *  mode only — folder mode is always visible (no footer to dock a badge in). */
  dismissed?: boolean;
  onDismiss?: () => void;
  onReopen?: () => void;
}) {
  const { t } = useLingui();
  // Folder mode vs doc mode. Folder mode scopes the composer to a folder (top-row
  // chip + dispatch lead) and skips every doc-coupled affordance: the selection
  // passage, the touched-file lifecycle, and the editor scroll-inset / caret
  // machinery (none of which has an editor or `.editor-doc-scroll` to act on).
  const folderMode = folderPath !== undefined;
  // The selection hooks read the visible editor for this doc; null in folder mode
  // so they no-op (no editor → no passage). The surface is defaulted only so those
  // (folder-unused) hooks have a concrete value — doc mode always supplies it.
  const activeDocOrNull = folderMode ? null : (docName ?? null);
  const effectiveSurface: EditorSurface = surface ?? 'wysiwyg';
  const reduced = useReducedMotion();
  const workspace = useWorkspace();
  const { pageMeta } = usePageList();
  const { states, refresh: refreshInstalledAgents } = useInstalledAgents();
  const overrides = useEnabledOverrides();
  const { dispatch } = useHandoffDispatch();
  // Desktop-only docked-terminal launcher (null on web). Its presence is what
  // lets the picker offer "Claude CLI" alongside the deep-link app targets,
  // matching the Open with AI menu.
  const terminalLaunch = useTerminalLaunch();
  // Read once on mount — a sticky pick from a prior session is re-read here
  // without a subscription.
  const [stickyId] = useState(() => loadStickyAgent());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The rich input owns its content; the host tracks only emptiness (pushed up
  // via `onEmptyChange`) to drive the placeholder + send-enabled state, and
  // reads the instruction + chip mentions at submit via the imperative handle.
  const [isEmpty, setIsEmpty] = useState(true);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<ComposerMentionInputHandle>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Shared draft doc — the SAME store the create/empty-screen hero composer
  // reads/writes, so a brief typed here (chips included) carries across
  // navigation (doc → folder → empty → doc) and into the create screen, and
  // survives reload. Seed the input from the stored ProseMirror doc once on mount
  // (the store, not this component's state, is the source of truth, so it
  // persists across the composer unmounting between placements, and `@`-mentions
  // restore as atomic chips rather than literal `@path` text); mirror every
  // keystroke back via `onContentChange`.
  const [initialDraftDoc] = useState(() => getComposerDraft().doc ?? undefined);

  // Publish the floating card's measured height (+ a small gap) so the editor
  // content insets its bottom padding to exactly clear the card — it grows with
  // the input and the selection pill, so a fixed inset over- or under-shoots and
  // hides the last lines. The var is the single source of truth: absent when the
  // composer is collapsed/hidden, so the inset collapses to 0 and the space is
  // reclaimed. Each change re-clamps any doc scroller left stranded past the now
  // shorter content — scroll anchoring otherwise holds the stale scrollTop and a
  // blank gap lingers below the content until the next manual scroll.
  useEffect(() => {
    // Folder mode docks the composer in-flow below the folder list (a flex child,
    // not an overlay), so none of the doc-overlay machinery applies — the
    // `--ask-composer-height` content inset, the bottom-anchored scroll pin, and
    // the caret-reveal all act on `.editor-doc-scroll` / the active editor, which
    // folder mode has neither of. The `docName == null` guard also narrows the
    // prop to a string for `getEditorForDoc` below (doc mode always supplies it).
    if (folderMode || docName == null) return;
    const root = document.documentElement;
    // Keep a bottom-anchored doc scroller pinned across the inset's padding
    // transition (~240ms). Capture which scrollers sit at (or near) the bottom
    // BEFORE the inset changes, then re-pin them to the moving bottom each frame:
    // on COLLAPSE the content eases up to fill the reclaimed space; on EXPAND it
    // eases down so the last lines stay above the newly-grown composer instead of
    // being covered. Also clamps any scroller stranded past shrinking content.
    const followBottom = () => {
      // Another writer owns this document's scroller — a mode-switch landing for
      // its whole settle window, or an explicit navigation for its brief hold —
      // so the pin must stand down for it exactly as it does for the user's own
      // wheel. Without this the pin wins: a deep mode flip momentarily clamps
      // the scroller to the bottom (the outgoing mode's scrollTop overshoots the
      // incoming mode's shorter content), which reads here as "bottom-anchored"
      // and re-pins the user to the end of the document every frame, stomping
      // the landing after it settled. The navigation case is the same shape with
      // a different cause: a jump the reader just asked for outranks the pin.
      if (isScrollRestoreSuppressed(docName)) return;
      const pinned = [...document.querySelectorAll<HTMLElement>('.editor-doc-scroll')].filter(
        (el) => {
          const max = el.scrollHeight - el.clientHeight;
          return max > 0 && el.scrollTop >= max - 40;
        },
      );
      if (pinned.length === 0) return;
      // Bounded to the transition window and cancelled the instant the user
      // scrolls — re-pinning every frame indefinitely would trap a scroll-up.
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
      };
      window.addEventListener('wheel', cancel, { passive: true });
      window.addEventListener('touchstart', cancel, { passive: true });
      const start = performance.now();
      const step = () => {
        // A landing or a navigation that takes the scroller mid-window cancels
        // the pin outright rather than pausing it: resuming afterwards would
        // yank the settled position back to the bottom, since `pinned` was
        // captured before that writer moved it.
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
    // On expand, if the active doc's caret/selection sits under the grown
    // composer, scroll it up so it stays visible above the card. WYSIWYG only —
    // source mode's visible editor is CodeMirror, not the active-editor registry.
    const revealCaret = () => {
      if (surface !== 'wysiwyg') return;
      requestAnimationFrame(() => {
        // Same standing-down rule as the bottom pin: never write scroll while
        // another writer owns the scroller, whether that is a landing settling
        // or an explicit navigation holding the place it just took.
        if (isScrollRestoreSuppressed(docName)) return;
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
          // PM view not mounted (recycle / race) — skip the reveal.
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
      // Capture the bottom-anchored state BEFORE the var (and its transition) move.
      followBottom();
      // Reserve room for the card PLUS the overlay's gradient-fade band above it
      // (the `pt-10` zone the card floats under): clearing only the card's hard
      // edge leaves the last line sitting under the translucent fade, where it
      // reads as covered.
      root.style.setProperty('--ask-composer-height', `${card.offsetHeight + 56}px`);
    };
    apply();
    // Expand: pull a covered caret into view if the user is editing near where the
    // composer just grew (the bottom pin above covers the view-the-bottom case).
    revealCaret();
    const observer = new ResizeObserver(apply);
    observer.observe(card);
    return () => {
      observer.disconnect();
      followBottom();
      root.style.removeProperty('--ask-composer-height');
    };
  }, [dismissed, surface, docName, folderMode]);

  // Mirror the latest dismissed/onReopen into refs so the once-bound ⇧⌘L handler
  // reads current values without re-subscribing (refs written in an effect, not
  // during render, keeps React Compiler happy).
  const dismissedRef = useRef(dismissed);
  const onReopenRef = useRef(onReopen);
  useEffect(() => {
    dismissedRef.current = dismissed;
    onReopenRef.current = onReopen;
  });

  // Single open+focus path, shared by ⇧⌘L and the editor's "Ask AI" selection
  // affordance (the bubble-menu button dispatches the same event): if the field
  // is dismissed it reopens first (the reopen effect below then focuses on the
  // dismissed -> visible flip); otherwise it focuses the input directly.
  useEffect(() => {
    const openAndFocus = () => {
      if (dismissedRef.current) onReopenRef.current?.();
      else inputRef.current?.focus();
    };
    return subscribeToOpenAskAiComposer(openAndFocus);
  }, []);

  // ⇧⌘L routes through the shared event so the button and the shortcut never
  // duplicate the reopen/focus logic.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesKeyboardShortcut(event, 'open-ask-ai')) return;
      if (isOverlayLayerOpen()) return;
      // Don't hijack ⇧⌘L when the caret is in a native form field (rename input,
      // search box, …) — only swallow it for the editor body / global context.
      if (isNativeTextControl(event.target)) return;
      event.preventDefault();
      emitOpenAskAiComposer();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  // Focus the input only on a genuine reopen (dismissed true -> false), so a
  // badge click or ⇧⌘L lands the caret in the field. Comparing against the
  // PREVIOUS dismissed value (rather than a "skip the first render" ref) keeps
  // the mount itself from focusing — and, crucially, survives React StrictMode's
  // dev-only effect double-invoke, which defeats a skip-first-render ref (the
  // second invoke sees the ref already set and steals focus). Without this the
  // composer grabs focus the moment a doc opens, closing an in-flight inline
  // rename input and stealing the caret from the editor.
  const prevDismissedRef = useRef(dismissed);
  useEffect(() => {
    const wasDismissed = prevDismissedRef.current;
    prevDismissedRef.current = dismissed;
    if (wasDismissed && !dismissed) inputRef.current?.focus();
  }, [dismissed]);

  // Host-level top-row file-context chips. The top row is the SET of whole-file
  // references the user has "touched" while drafting, with this lifecycle:
  //   - empty prompt → no file chip (nothing touched yet);
  //   - first keystroke while a doc is open → add that doc;
  //   - switching docs while the draft is non-empty → add THAT doc too (chips
  //     accumulate: start in A, type, switch to B → chips A and B);
  //   - X'ing a chip sticky-dismisses its path for the life of this draft (never
  //     re-added, even on revisit);
  //   - a file referenced inline as an `@`-mention is NOT also a top chip — inline
  //     wins, recomputed live whenever the inline-mention set changes.
  // Typed `@`-mentions stay INLINE (each a removable `composerMention` chip), so
  // the top row never duplicates an inline reference. Reset on dispatch/clear.
  const [touchedFiles, setTouchedFiles] = useState<readonly string[]>([]);
  const [dismissedFiles, setDismissedFiles] = useState<ReadonlySet<string>>(() => new Set());
  // The count that matters is what a send would carry — the CHECKED subset.
  // Unchecking every item leaves the queue non-empty but the send empty, so
  // gate the send button on this too rather than on the raw queue length.
  const selectedCommentCount = useSelectedCommentCount();
  // The files the batch draws from — the chip says so when there is more than one.
  const selectedCommentDocs = useSelectedCommentDocs();
  // Ticked in the Comments panel = riding this message, so this starts ON.
  // There is no attach step to find: the panel's checkboxes were already a
  // picker, and a second opt-in here meant a batch you had just built sat one
  // differently-shaped click away from the send meant to carry it.
  //
  // The chip's ✕ turns it off for THIS draft and nothing else — a composer
  // opened for an unrelated question is a statement about the message, not
  // about which comments you meant to send, so the ticks stay as they were and
  // the chip is the way back.
  const [commentsAttached, setCommentsAttached] = useState(true);
  const hasQueuedComments = selectedCommentCount > 0 && commentsAttached;
  // The current inline-mention `@path` set, pushed up from the editor — used to
  // dedup the top row against inline mentions (the live invariant).
  const [inlineMentions, setInlineMentions] = useState<readonly string[]>([]);

  // Add the active doc to the touched set the moment the draft goes non-empty,
  // and again whenever the active doc changes while still drafting (accumulate on
  // switch). Sticky-dismissed paths are never re-added. Keyed on `isEmpty` +
  // `docName` so a file-switch mid-draft fires it.
  const activeFilePath =
    folderMode || docName == null
      ? ''
      : docNameToComposerRelativePath(docName, pageMeta.get(docName)?.docExt);
  useEffect(() => {
    // Folder mode has no active doc to "touch" — its single top-row chip is the
    // folder itself, derived below, not the touched-file set.
    if (folderMode || isEmpty) return;
    setTouchedFiles((prev) => {
      if (dismissedFiles.has(activeFilePath)) return prev;
      const activeStem = markdownRelativePathStem(activeFilePath);
      const next =
        activeStem === null
          ? prev
          : prev.filter(
              (path) => path === activeFilePath || markdownRelativePathStem(path) !== activeStem,
            );
      if (next.includes(activeFilePath)) return next.length === prev.length ? prev : next;
      return [...next, activeFilePath];
    });
  }, [folderMode, isEmpty, activeFilePath, dismissedFiles]);

  // The visible top-row context chips.
  //   - Folder mode: the folder is the sole chip — the composer's scope — present
  //     from the first render and removable like a file chip (X'ing it sticky-
  //     drops to project scope, and an inline `@`-mention of the same folder wins
  //     so the row never duplicates it). The content-root folder (`folderPath`
  //     === '') has no meaningful chip and dispatches as bare project scope, so
  //     the `folderPath` truthiness guard leaves the row empty there.
  //   - Doc mode: the touched-file set minus dismissed minus currently-inline. A
  //     path mentioned inline is dropped here (inline wins); removing the inline
  //     mention lets it reappear (still subject to sticky-dismiss).
  // Derived in render so it recomputes the moment any input changes — React
  // Compiler handles it.
  const fileChips = folderMode
    ? folderPath && !dismissedFiles.has(folderPath) && !inlineMentions.includes(folderPath)
      ? [folderPath]
      : []
    : touchedFiles.filter((path) => !dismissedFiles.has(path) && !inlineMentions.includes(path));

  // Capture the document's live selection as a removable snapshot pill. Every
  // fresh non-empty selection replaces the pill; collapsing the selection leaves
  // it pinned (the user can keep typing or remove it with the ×). Two live
  // sources feed it: the active body surface (wysiwyg / source) AND the
  // frontmatter property panel — a highlight in either pins the same pill, so a
  // property-value selection feeds the composer exactly like a body selection.
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
  // A pinned selection deliberately outlives the editor selection so it can
  // survive clicking away into the composer. Filing a comment is the one case
  // where that is wrong: the passage now rides the batch as that comment's
  // quote, and leaving it pinned would send the same words again as an
  // unrelated in-scope selection.
  useEffect(
    () =>
      subscribeCommentPosted(() => {
        setPinnedSelection(null);
        setSelectionExpanded(false);
        // A NEW comment re-attaches the batch. The ✕ says "not this message",
        // about the batch as it stood; writing another one is a fresh statement
        // of intent about the same message, and the same reason posting queues a
        // comment rather than asking twice. Without this the comment you just
        // wrote sat outside the send, with a dismissed chip as the only clue.
        setCommentsAttached(true);
      }),
    [],
  );

  // Explicit pick this session wins; otherwise the sticky preference; otherwise
  // first-installed. `selectedId` stays null until the user picks so a
  // freshly-installed agent can take over the default mid-session. A per-CLI
  // sentinel (`terminal-cli:<cli>`) only resolves to terminal mode when the
  // launcher is available, so a sticky CLI pick degrades to the first app target
  // on the web host.
  const defaultRegisteredAgent = useDefaultRegisteredAgent();
  // Every registered agent gets its own picker row — only the ENABLED ones show.
  const registeredThreadAgents = useRegisteredAgents();
  const enabledThreadAgents = registeredThreadAgents.filter((agent) =>
    isInAppAgentEnabled(overrides, agent.source, agent.id, true, agent.supported),
  );
  // The in-app agent the primary launches + names: the registered default when
  // it is still enabled, else the first enabled one.
  const defaultThreadAgent = pickEffectiveDefaultAgent(enabledThreadAgents, defaultRegisteredAgent);

  // One selection decision, enablement-aware for every category — shared with the
  // create composer + sessions dock via `resolveLauncherSelection`, so a disabled
  // agent / CLI / app is never what the primary launches on any surface.
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

  // Sendable with a typed instruction OR a pinned selection alone (the passage
  // is enough context to hand off).
  const canSend =
    !pending &&
    // Queued comments are enough on their own: each carries its own body, and
    // an untyped batch still has a default instruction. Requiring typed text
    // would leave the send button dead with a full queue.
    (!isEmpty || pinnedSelection !== null || hasQueuedComments) &&
    (isTerminalSelected || resolvedTarget !== null || isThreadSelected);

  // Picker options for the split button's menu. External-app rows are the
  // desktop apps detected on this machine, minus anything the user turned off in
  // Configure agents (and plus anything they turned on that isn't installed —
  // that one routes to its installer on launch).
  // `agentProbePending` distinguishes "still detecting" from "none" for the hint.
  const desktopAgents = VISIBLE_TARGETS.filter((target) =>
    isDesktopTargetEnabled(overrides, target.id, states[target.id]?.installed),
  );
  const agentProbePending = VISIBLE_TARGETS.some((target) => states[target.id]?.installed == null);

  // The docked-terminal CLI rows (desktop only) — one row per launchable CLI,
  // sourced identically to the empty-state Create composer so the two pickers
  // can't drift: the bare brand name is the visible label, and the accessible
  // name carries "<name> CLI" (WCAG 2.5.3 — the accessible name contains the
  // visible label) so AT users can tell a Terminal row apart from a same-named
  // Desktop row. The "Terminal" section header plus the brand icon carry that
  // same distinction for sighted users. Rows are the ENABLED CLIs
  // (`enabledTerminalClis`, the same set the selection resolver reads), so an
  // uninstalled or toggled-off CLI never appears — and since `selectedCli` is
  // only ever an enabled CLI, no keep-guard is needed.
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

  // Rotating example prompts shown as an animated placeholder while empty. With
  // comments queued the placeholder stops rotating and states what sending will
  // do — that IS the default instruction the batch carries when nothing is
  // typed, so it should be visible rather than implicit.
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

  // Stickiness persists on PICK, not gated to submit: the
  // moment the user chooses an agent/CLI in the dropdown it becomes the default
  // for the next session. The submit path no longer re-saves (it would be a
  // redundant double-write of the same id).
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

  // Picking a specific registered agent re-registers it (making it the
  // default the submit path launches — "the agent you chose last is your
  // agent") and selects thread mode.
  const handleSelectThreadAgent = (agent: RegisteredAgent) => {
    registerAgent(agent);
    handleSelectThread();
  };

  const clearComposer = () => {
    inputRef.current?.clear();
    setPinnedSelection(null);
    setSelectionExpanded(false);
    // Reset the file-chip lifecycle for a fresh draft: drop the touched set + the
    // sticky-dismissed tracking (and `inlineMentions` follows the cleared editor).
    setTouchedFiles([]);
    setDismissedFiles(new Set());
    // Back to the default for the next message. The TICKS are the panel's state
    // and deliberately survive — this only resets the one bit that belongs to
    // the draft, so a batch dismissed from one message is not silently dismissed
    // from every message after it.
    setCommentsAttached(true);
    // Clear the SHARED draft too so a sent prompt does not reappear in the
    // create-screen hero (or on the next navigation back to a doc).
    clearComposerDraft();
  };

  // Shared dispatch tail for a composed handoff input — identical across doc /
  // folder / project scope. Surfaces the rare null-workspace case, routes a CLI
  // pick to the docked terminal (else the installed-agent deep-link), and clears
  // the draft on completion.
  //
  // Resolves to whether the prompt actually reached an agent. The queued-comment
  // send is the caller that needs the answer: a batch reported as delivered is
  // resolved and dropped from the queue, so a branch that hands off nothing —
  // no resolved target, a terminal that refused to open, an uninstalled agent
  // routed to its download page, a deep-link dispatch that came back not-ok —
  // has to say so rather than let the comments close on a send that never
  // happened.
  const dispatchComposed = async (
    input: ReturnType<typeof buildComposerHandoffInput>,
    /**
     * Clear the composer once the prompt is away. True for a plain send, where
     * this function IS the send.
     *
     * The queued-comment path passes false, because there this is only the
     * hand-off — the send is not finished until `dispatchComments` reports what
     * actually shipped, and that caller owns the clear. Two owners meant the
     * clear ran twice on that path, and worse, the not-installed branch below
     * cleared while returning false: the typed instruction was thrown away on a
     * batch that never left the queue.
     */
    clearOnSuccess = true,
  ): Promise<boolean> => {
    const clearIfOwned = () => {
      if (clearOnSuccess) clearComposer();
    };
    if (input === null) {
      // Defensive: `buildComposerHandoffInput` returns null only when the
      // workspace hasn't resolved yet, and the composer normally only shows once
      // a doc / folder (hence a workspace) is open — so this is rarely reachable.
      // Surface a toast rather than a silent no-op if it is.
      toast.error(t`Couldn't send your prompt — please try again.`);
      return false;
    }
    // In-app agent thread: open a server-hosted thread with the composed prompt
    // (like "Open with AI → Start an agent"), then clear. Works on every host.
    // Launch the effective (enabled) agent explicitly so a disabled registered
    // default is never launched.
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
    // CLI mode: hand the composed prompt to the docked terminal for the selected
    // CLI (like Open with AI) and clear. No deep-link dispatch. Stickiness already
    // persisted on pick (handleSelectCli), so no save here. If the launch throws
    // (no terminal session could be opened), keep the draft intact and toast so
    // the user can retry rather than losing what they typed to a silent failure.
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
    // Nothing resolved to send to. `submit` gates on `canSend` before reaching
    // here, so this is the defence-in-depth path for callers that don't (the
    // agent-picker rows dispatch directly) — say why rather than swallowing it.
    if (resolvedTarget === null) {
      toast.error(t`No agent is set up yet — pick one from the send menu.`);
      return false;
    }
    // An enabled-but-not-installed Desktop agent routes to its installer
    // rather than a failing deep-link dispatch (the toggle can enable an agent
    // the user hasn't installed yet).
    if (states[resolvedTarget.id]?.installed !== true) {
      void openInstallUrl(resolvedTarget);
      toast.info(t`${resolvedTarget.displayName} isn't installed yet — opening its download page.`);
      clearIfOwned();
      return false;
    }
    setPending(true);
    // dispatchHandoff never throws and toasts success/error itself; on resolve
    // we clear regardless of outcome (the toast carries any retry). The onboarding
    // step records only on a confirmed-successful outcome — a failed handoff
    // ({ ok: false }: agent offline, install error) must not check it off, matching
    // the success-gated terminal path above.
    //
    // `Promise.finally`, not `try`/`finally`: React Compiler cannot lower a
    // TryStatement with no catch clause and fails the build on it, so the
    // clean-up-regardless has to ride the promise rather than the syntax.
    const outcome = await dispatch(resolvedTarget.id, input).finally(() => {
      setPending(false);
      clearIfOwned();
    });
    if (outcome.ok) recordOnboardingAskedAi();
    return outcome.ok;
  };

  // Collect the current draft — typed instruction, `@`-mention chips, and any
  // pinned selection passage — into one handoff input. `submit` is the only
  // caller; the picker's Configure agents row takes no input and just opens
  // Settings.
  const composeCurrentInput = () => {
    const { instruction, mentions } = inputRef.current?.getContent() ?? {
      instruction: '',
      mentions: [],
    };

    if (folderMode) {
      // Folder scope: the folder is the dispatch lead (the assembler auto
      // `@`-mentions it). The folder chip itself never doubles as a `@path`
      // mention; any other inline mentions ride along, deduped.
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

    // The pinned doc selection rides as a passage: inline text for a short
    // single-line pick, a line-range or anchor reference otherwise.
    const selection = pinnedSelection ? selectionSnapshotToCompose(pinnedSelection) : undefined;
    // The dispatched context is the chip SET — top-row file chips + inline
    // `@`-mentions — not a single hardcoded active doc. The doc-scope LEAD is:
    //   - the SELECTION's own doc when a passage is pinned (the passage needs its
    //     OWN doc as the lead — the selection can come from a doc the user has
    //     since navigated away from, so the active `docName` would be the wrong
    //     lead and the passage would be attributed to the wrong file);
    //   - else the active doc when it's a visible file chip;
    //   - else null (project scope — bare project directive).
    // Every other file chip rides as a `@path` mention, deduped against inline
    // mentions and the lead. With no chips and no inline mentions this is bare
    // project scope.
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
    // The gate runs FIRST, for the queued path too. `canSend`'s content clause
    // already counts an attached queue as content, so this does not reinstate
    // the "type something first" requirement a batch is exempt from — it just
    // stops the queued send from skipping the not-pending and has-a-target
    // checks. Those were being caught downstream by `dispatchInFlight` and a
    // toast in `dispatchComposed`, which is two unrelated mechanisms standing in
    // for one guard.
    if (!canSend) return;
    // Queued comments take over the send: the typed text becomes the shared
    // instruction for the batch, and every queued comment rides along with its
    // own doc + passage. One send, one agent turn.
    if (hasQueuedComments) {
      // `dispatchComments` reports every failure it knows about and returns an
      // empty batch, so nothing here should reject. If something upstream ever
      // does, the composer is already in the safe state — draft intact, batch
      // still attached, comments still queued — so this only has to keep the
      // rejection from disappearing.
      submitQueuedComments().catch((err) => {
        console.warn('[comments] queued-comment send rejected unexpectedly', err);
      });
      return;
    }
    void dispatchComposed(composeCurrentInput());
  };

  /**
   * Dispatch the queued comments as one turn. The server re-finds each anchor
   * first (so a passage that moved is still found, and one that is gone is
   * flagged rather than silently retargeted), then the batch resolves only if
   * the hand-off actually happened.
   *
   * Re-entrant sends (a second Enter before the first batch completes) are held
   * off by `dispatchQueueAsBatch` itself, not here — the queue-panel Send drains
   * the same queue and needs the same guard.
   */
  const submitQueuedComments = async () => {
    const { instruction, mentions } = inputRef.current?.getContent() ?? {
      instruction: '',
      mentions: [],
    };
    const shipped = await dispatchComments({
      compose: async (items: readonly BatchPreparedItem[]) => {
        const input = buildComposerHandoffInput({
          // Project scope: a batch spans documents, so no single doc leads. Each
          // comment names its own file in the composed instruction.
          docName: null,
          workspace,
          instruction: composeCommentBatchInstruction(
            items.map((item) => toCommentBatchItem(item.payload)),
            instruction,
            // The pinned selection is the one chip the batch cannot reconstruct —
            // a passage that belongs to no comment. It used to render above the
            // send and then be dropped by it.
            pinnedSelection
              ? { docName: pinnedSelection.docName, markdown: pinnedSelection.markdown }
              : undefined,
          ),
          // Every touched doc, not only the batch's: a file chip or `@`-mention
          // added while drafting is context for THIS send too. Deduped, so a doc
          // that is both commented on and chipped is named once.
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
        // `false`: this is the hand-off, not the send. `dispatchComments` decides
        // what shipped, and the clear below is keyed off that — so a batch that
        // fails to leave the queue keeps the instruction you typed for it.
        return dispatchComposed(input, false);
      },
    });
    if (shipped.length > 0) clearComposer();
  };

  // Dismissed: render nothing (the host shows the footer reopen badge). The
  // component stays mounted above this point so the ⇧⌘L handler can reopen it.
  if (dismissed) return null;

  // Compact, Cursor-style selection chip: `name (range)` — the doc basename
  // plus a line range (source mode) or extent (rich text / frontmatter), NEVER
  // raw markdown. The light-rendered preview (headings → text, `-`/`*` → `•`,
  // tables/code/components → block name, newlines dropped) is the expand/peek
  // view below, so a heading / list / table selection no longer leaks literal
  // `##` / `-` / `**` into the chip label.
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

  // Self-contained rounded field: the card owns the border + focus ring so the
  // whole box lights up on focus (mirrors the empty-state composer). A captured-
  // selection pill, when present, is a full-width strip above the input row, so
  // the card stacks its children vertically. The card markup is mode-agnostic;
  // only the outer host wrapper (overlay vs in-flow) differs below.
  const card = (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer clicks only delegate focus to the composer's editable; keyboard users focus it directly (Tab / ⇧⌘L).
    <div
      ref={cardRef}
      // Click anywhere in the card's whitespace (padding, row gaps, the space
      // beside the short single-line input) focuses the field — the standard
      // chat-composer affordance. Presses on the send button / chips / editable
      // are left alone. See focus-composer-on-card-pointer.ts.
      onMouseDown={(event) => focusComposerInputOnCardPointer(event, inputRef)}
      className="pointer-events-auto group relative flex cursor-text flex-col gap-1.5 rounded-2xl border border-border/60 bg-card px-3 py-2 shadow-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
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
                // h-auto + min-h-0 collapse the shadcn Button's default h-8 so the
                // peek toggle sits at its text height — without it the pill is ~2rem
                // tall instead of matching the file chip's ~1.25rem (a plain span).
                // `shrink` overrides the Button base's `shrink-0` so the label can
                // shrink within the pill's max-w and the inner span can truncate
                // (label-on-the-Button `truncate` is inert: an inline-flex button
                // never ellipsizes its own text child); without it the long label
                // overflows the chip's border.
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
        {/* Queued comments ride the same chip row as files + the selection pill:
            the queue lives in the composer you already use, not a separate
            dispatch surface. What is ticked in the Comments panel is what this
            counts — the panel is the picker, and the chip is its read-out.

            Gated on the TICKED count, not on `hasQueuedComments`: detached, the
            chip is the way back and has to still be there. Gated here as well as
            inside the chip because `ComposerContextChips` decides whether to
            render its row at all by counting children, and an element that
            returns null still counts as one — nothing ticked has to contribute
            NO child, or the chip row appears as an empty strip. */}
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
                // `truncate` keeps a long suggestion on one line (ellipsis at the
                // input's right edge) so it never wraps past the slim resting pill —
                // the placeholder is a hint, and the field only grows once you type.
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
              {/* The external-action arrow only rides the desktop-app primary:
                  that click leaves OK for another app, where every other primary
                  stays in this window. */}
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
          // Detection drives which external apps appear, so re-probe as the menu
          // opens — an app installed since boot shows up on this open rather than
          // waiting for the next window focus. Throttled per scheme in the probe
          // coordinator.
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
            // Back-compat: the Claude row keeps the original singular id; the
            // new Codex / Cursor rows are namespaced under `terminal-` so they
            // never collide with the Desktop `ask-ai-agent-option-<id>` rows.
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
    // In-flow docked field below the folder list — centered on the same
    // `max-w-4xl px-6` column FolderOverview uses for its content, so the card
    // aligns with the list above it. No overlay/gradient/inset machinery (that is
    // doc-scroll-specific) and no collapse handle.
    return (
      <div className="shrink-0 pt-2 pb-3" data-testid="bottom-composer">
        <div className="mx-auto w-full max-w-4xl px-6">{card}</div>
      </div>
    );
  }

  return (
    // Floats over the bottom of the editor's scroll area (absolute overlay, set
    // by EditorArea). `editor-content-aligned` lands the card on the editor's
    // `content` column (via the `> *` rule) so its width tracks the WYSIWYG body.
    // The background fades to transparent at the top so content scrolls out of
    // view beneath it (rather than meeting a hard edge); `pointer-events-none`
    // lets clicks through the faded margin, the card itself re-enables them.
    <div
      // The bottom anchor tracks `--conflict-footer-height` (published by
      // DiffView while a conflict is being resolved; 0px otherwise) so the
      // composer stacks above the Exit merge / Undo / Save resolution bar
      // instead of covering it.
      className="pointer-events-none absolute inset-x-0 bottom-[var(--conflict-footer-height,0px)] z-20 editor-content-aligned bg-gradient-to-t from-background from-65% via-background to-transparent pt-10 pb-2"
      data-testid="bottom-composer"
    >
      {card}
    </div>
  );
}
