/**
 * Renders one ACP agent thread: the message/tool-call transcript, the live
 * plan checklist, inline permission prompts, a mode picker, and the prompt
 * composer with cancel. UX reference: Zed's agent panel — a single scrolling
 * transcript of turns with tool calls shown as collapsible cards.
 *
 * All copy routes through Lingui; every interactive primitive is a shadcn
 * component (this subtree is NOT the ProseMirror-exempt editor tree).
 */

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import type {
  QueuedMessage,
  SessionConfigOption,
  ThreadFailureDetail,
  ThreadInfo,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { useLingui } from '@lingui/react/macro';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Download,
  FileText,
  FolderInput,
  Globe,
  History,
  Link2,
  ListPlus,
  Loader2,
  MousePointer2,
  RotateCcw,
  Search,
  Settings2,
  Share2,
  Shuffle,
  Sparkles,
  Square,
  SquarePen,
  Terminal as TerminalIcon,
  Trash2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { Fragment, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  composeCommentBatchInstruction,
  QueuedCommentsChip,
  QueuedCommentsList,
  toCommentBatchItem,
  useQueuedComments,
  useSelectedCommentCount,
} from '@/comments/comment-chips';
import { dispatchComments, selectAllQueued } from '@/comments/store';
import type { CommentThread } from '@/comments/types';
import { ComposerContextChips } from '@/components/ComposerContextChips';
import { focusComposerInputOnCardPointer } from '@/components/focus-composer-on-card-pointer';
import { useOptionalPageList } from '@/components/PageListContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupSeparator } from '@/components/ui/button-group';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@/components/ui/message-scroller';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorkingAvatar } from '@/components/WorkingAvatar';
import { useDocumentContext } from '@/editor/DocumentContext';
import {
  agentSettingsKey,
  rememberAgentConfigOption,
  rememberAgentMode,
} from '@/lib/acp/agent-settings-store';
import { configValueHint, resolveDefaultOptionLabel } from '@/lib/acp/config-value-hints';
import { computeDiffRows } from '@/lib/acp/inline-diff';
import { isPermissiveMode } from '@/lib/acp/permissive-mode';
import { renderTerminalText } from '@/lib/acp/terminal-text';
import {
  getAgentThreadClient,
  ThreadResumeError,
  useAgentThread,
  useAgentThreadModel,
} from '@/lib/acp/thread-client';
import { subscribeStagedThreadDraft } from '@/lib/acp/thread-draft-staging';
import {
  type PermissionOutcome,
  type RenderedItem,
  type RenderedPermission,
  type RenderedTerminal,
  type RenderedToolCall,
  resolvePermissionOutcome,
} from '@/lib/acp/thread-event-model';
import { describeToolCall, type ToolCallGlyph } from '@/lib/acp/tool-call-display';
import { docNameFromHash, hashFromDocName } from '@/lib/doc-hash';
import { useWorkspace } from '@/lib/use-workspace';
import { cn } from '@/lib/utils';
import { AgentMarkdown } from './AgentMarkdown';
import {
  decideFollowNavigation,
  type FollowNavState,
  INITIAL_FOLLOW_NAV_STATE,
  latestFollowTarget,
  loadFollowFilePref,
  pageListFollowOptions,
  saveFollowFilePref,
} from './follow-file';
import { appendPresenceWrite, latestAgentWrite, type PresenceWrite } from './presence-follow';
import { RegisteredAgentIcon } from './RegisteredAgentIcon';
import { transcriptItemId } from './transcript-item-id';
import { activeToolKind, useThinkingLine, workingStatusText } from './working-status';

/**
 * Stop sends ACP `session/cancel` — a courtesy the agent may ignore while it
 * keeps generating (and billing). Past this window the view stops pretending
 * and offers the force-quit escape hatch.
 */
const CANCEL_STALL_MS = 10_000;

/**
 * How long a finished tool call holds its check before fading. Long enough to
 * register as an acknowledgement, short enough that a settled transcript — the
 * state you scroll back through — carries no per-row status chrome at all.
 */
const COMPLETION_CHECK_MS = 1_400;

const TOOL_ICONS: Record<ToolCallGlyph, typeof Wrench> = {
  read: FileText,
  edit: SquarePen,
  delete: Trash2,
  move: FolderInput,
  search: Search,
  execute: TerminalIcon,
  think: Sparkles,
  fetch: Globe,
  switch_mode: Shuffle,
  check: CircleCheck,
  link: Link2,
  history: History,
  share: Share2,
  install: Download,
  settings: Settings2,
  restore: RotateCcw,
  other: Wrench,
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Display name for an agent — drops a trailing "Agent" so it reads as the brand
 *  ("Claude Agent" → "Claude"). */
function agentDisplayName(name: string): string {
  return name.replace(/\s+Agent$/i, '');
}

/**
 * Failures a fresh launch can plausibly clear — mirrors the server's
 * `retryThread` guards (a thread that never opened a session). Everything
 * else, including a prompt failure on a live session, gets no Retry.
 */
const RETRYABLE_FAILURE_REASONS: ReadonlySet<ThreadFailureDetail['reason']> = new Set([
  'connect',
  'session-setup',
  'auth-required',
]);

function isRetryableFailure(failure: ThreadFailureDetail): boolean {
  return RETRYABLE_FAILURE_REASONS.has(failure.reason);
}

export function ThreadView({
  info,
  active = true,
}: {
  info: ThreadInfo;
  /**
   * Whether the user is actively viewing this thread (its tab is selected AND
   * the sessions dock is on screen). Every open thread's ThreadView stays
   * mounted at once (the dock force-mounts panels so transcripts survive tab
   * switches), so without this gate a background thread's agent write would
   * yank the editor's follow-the-file navigation out from under a user reading
   * an unrelated page. Only the actively-viewed thread drives follow. Defaults
   * true so a lone ThreadView (tests, any single-thread host) still follows.
   */
  active?: boolean;
}): ReactNode {
  const { t } = useLingui();
  const state = useAgentThread(info.threadId);
  const client = getAgentThreadClient();
  const workspace = useWorkspace();
  const [draft, setDraft] = useState('');
  const [followFile, setFollowFile] = useState(loadFollowFilePref);
  // Captured by ScrollToEndBridge (a child of the scroller Provider) so send/
  // resume can imperatively jump to the live edge; null until the bridge mounts.
  const scrollApiRef = useRef<ReturnType<typeof useMessageScroller> | null>(null);
  // Follow-the-file bookkeeping: `initialSeqRef` marks the event log position
  // at mount so a replayed history (reload, tab switch) never yanks the
  // editor around — only events that arrive live do. `followNavRef` carries the
  // last-followed target + the yield latch across events (see
  // decideFollowNavigation); it re-arms per turn and on the follow toggle.
  const initialSeqRef = useRef<number | null>(null);
  const followNavRef = useRef<FollowNavState>(INITIAL_FOLLOW_NAV_STATE);
  const prevTurnActiveRef = useRef(false);

  // A selection send (⌘J) or Problems-panel "Ask AI" that resolved to this agent
  // seeds the composer instead of auto-sending, so the user reviews and extends
  // the passage before spending a turn — the same stage-don't-submit contract the
  // terminal CLI path honors. Appends rather than overwrites so a staged value
  // arriving after the user started typing can't eat their words.
  useEffect(() => {
    return subscribeStagedThreadDraft(info.threadId, (text) => {
      setDraft((prev) => (prev.trim() === '' ? text : `${prev.replace(/\s+$/, '')}\n\n${text}`));
    });
  }, [info.threadId]);

  // Incrementally folded in the store — never re-fold `state.events` here;
  // the per-render full fold was O(transcript) per streamed chunk.
  const model = useAgentThreadModel(info.threadId);
  const status = info.status;
  const archived = info.archived === true;
  // An archived transcript can end mid-turn (server crash while streaming) —
  // never let the fold's stale turn state drive the running UI.
  const turnActive = model?.turnActive === true && !archived;
  // Only consulted when no tool call is in flight — see `working-status.ts`.
  const thinkingLine = useThinkingLine(turnActive);
  const [resumePending, setResumePending] = useState(false);
  const [resumeError, setResumeError] = useState<ThreadResumeError | null>(null);
  const canPrompt = archived ? !resumePending : status === 'ready' && !turnActive;
  // A live thread sitting in a failure status never opened a session, so the
  // launch can simply be run again — see the server's `retryThread` guards.
  const canRetry = !archived && (status === 'error' || status === 'auth_required');
  const [retryPending, setRetryPending] = useState(false);
  // Mid-turn sends don't reject anymore — the server queues them behind the
  // active turn and drains FIFO (`ThreadInfo.queue`).
  const canQueue = !archived && turnActive;
  // Read-shaped follow targets (exec `cat foo.md`, or a non-`edit` call's
  // newest location) only navigate to docs that exist — a read of a missing
  // file would open a blank create-on-open tab. `pageListFollowOptions`
  // arms the predicate only when the page-list snapshot is authoritative;
  // the exact loading/error rules live at the helper (unit-tested there).
  const followOptions = pageListFollowOptions(useOptionalPageList());
  const transcriptFollowTarget =
    model !== null ? latestFollowTarget(model.items, workspace, followOptions) : null;

  // Presence-derived write stream — the fallback when the transcript is
  // informationally empty (some adapters send rawInput {} and no locations
  // for every call; observed live with Cursor). The server refreshes
  // `agentPresence.currentDoc` on every MCP write it executes, so this stream
  // is authoritative regardless of what the adapter reports. Collected only
  // while a turn is streaming; reset per turn.
  const { systemProvider } = useDocumentContext();
  const [presenceWrites, setPresenceWrites] = useState<ReadonlyArray<PresenceWrite>>([]);
  useEffect(() => {
    if (!turnActive) {
      setPresenceWrites([]);
      return;
    }
    const awareness: unknown = systemProvider?.awareness;
    const observe = () => {
      const write = latestAgentWrite(awareness, Date.now());
      if (write !== null) setPresenceWrites((previous) => appendPresenceWrite(previous, write));
    };
    observe();
    const listenable =
      typeof awareness === 'object' &&
      awareness !== null &&
      typeof (awareness as { on?: unknown }).on === 'function' &&
      typeof (awareness as { off?: unknown }).off === 'function'
        ? (awareness as {
            on(event: 'change', handler: () => void): void;
            off(event: 'change', handler: () => void): void;
          })
        : null;
    listenable?.on('change', observe);
    return () => listenable?.off('change', observe);
  }, [turnActive, systemProvider]);

  // The transcript wins when it carries targets at all (richer + proven for
  // adapters that populate rawInput/locations); presence covers the rest.
  const followTarget =
    transcriptFollowTarget ??
    (presenceWrites.length > 0 ? (presenceWrites[presenceWrites.length - 1]?.doc ?? null) : null);
  const lastSeq = state?.lastSeq ?? null;
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelStalled, setCancelStalled] = useState(false);

  // The turn actually ended — Stop worked (or the thread died with it).
  useEffect(() => {
    if (!turnActive) {
      setCancelPending(false);
      setCancelStalled(false);
    }
  }, [turnActive]);

  useEffect(() => {
    if (!cancelPending || !turnActive) return;
    const timer = setTimeout(() => setCancelStalled(true), CANCEL_STALL_MS);
    return () => clearTimeout(timer);
  }, [cancelPending, turnActive]);

  const requestCancel = (): void => {
    // Stop clears the queue and any parked steer server-side, and has to: a
    // compliant agent answers the cancel through the same continuation that
    // dispatches them, so anything retained would fire at the agent the user
    // just stopped. Folding the words back into the composer is the rescue —
    // they survive, nothing sends. The steer leads, because that is the order
    // it was going to run in.
    const rescued = [
      ...(info.steer !== undefined ? [info.steer.content] : []),
      ...(info.queue ?? []).map((message) => message.content),
    ];
    if (rescued.length > 0) {
      const text = rescued.join('\n\n');
      setDraft((prev) => (prev.trim() === '' ? text : `${prev.replace(/\s+$/, '')}\n\n${text}`));
    }
    client.cancel(info.threadId);
    setCancelPending(true);
  };

  /**
   * Stop the running turn and send the draft as the next one. Always an
   * explicit click — Enter stays the queue-behind-the-turn default, because
   * interrupting a run is not something a habit keystroke should do.
   */
  const requestSteer = (): void => {
    const text = draft.trim();
    if (text === '') return;
    client.steer(info.threadId, text);
    setDraft('');
    scrollApiRef.current?.scrollToEnd();
  };

  useEffect(() => {
    if (lastSeq !== null && initialSeqRef.current === null) initialSeqRef.current = lastSeq;
  }, [lastSeq]);

  // A retry that succeeded leaves the failure status behind; the button it was
  // spinning on is gone with it.
  useEffect(() => {
    if (!canRetry) setRetryPending(false);
  }, [canRetry]);

  // Re-arm follow at the start of each turn: a new turn is the user directing
  // the agent again, so a yield latched during the previous turn (they read
  // another page) is cleared and follow tracks the new work afresh.
  //
  // Preserve `lastFollowed` — resetting it would lose the same-target dedupe
  // that keeps a stale `followTarget` (carried across turns via the
  // accumulated event log) from yanking the user to yesterday's work the
  // instant they press send. Set `reArmed` so the NEXT fresh target this
  // turn bypasses the off-track check exactly once — the user's new intent
  // beats their prior yield.
  //
  // Defined before the follow effect so the reset lands before the
  // same-commit follow.
  useEffect(() => {
    if (turnActive && !prevTurnActiveRef.current) {
      followNavRef.current = { ...followNavRef.current, yielded: false, reArmed: true };
    }
    prevTurnActiveRef.current = turnActive;
  }, [turnActive]);

  // Follow the agent's file: navigate the editor to the doc the agent is
  // working on, as it works. Gated four ways: only when following is on, only
  // while a turn is streaming, only on live events (see initialSeqRef above),
  // and only for the actively-viewed thread (`active`) — a background thread's
  // write must never yank a reader off their page. `decideFollowNavigation`
  // owns the dedupe + yield-to-manual-navigation policy.
  useEffect(() => {
    if (!active || !followFile || followTarget === null || !turnActive) return;
    if (initialSeqRef.current === null || lastSeq === null || lastSeq <= initialSeqRef.current) {
      return;
    }
    const currentDoc = docNameFromHash(window.location.hash);
    const decision = decideFollowNavigation(followTarget, currentDoc, followNavRef.current);
    followNavRef.current = decision.state;
    if (decision.navigateTo !== null) {
      window.location.assign(hashFromDocName(decision.navigateTo));
    }
  }, [active, followFile, followTarget, turnActive, lastSeq]);

  const toggleFollow = (): void => {
    const next = !followFile;
    setFollowFile(next);
    saveFollowFilePref(next);
    // Re-enable = user explicitly wants follow back, no matter where they
    // are. Full reset (`INITIAL_FOLLOW_NAV_STATE`) is correct here — unlike
    // the turn-boundary re-arm, we want the current followTarget to
    // navigate them immediately even if it matches a stale value, because
    // the toggle-on IS the user's explicit intent to move.
    if (next) {
      followNavRef.current = INITIAL_FOLLOW_NAV_STATE;
    }
  };

  // The last resume-carried message that failed — the "new thread" fallback
  // re-sends it there. Kept out of the draft: the server's optimistic echo
  // already shows it in the transcript, so putting it back in the composer
  // would read as two copies.
  const [failedPrompt, setFailedPrompt] = useState<string | null>(null);

  // Queued review comments ride this composer the same way they ride the Ask AI
  // one: the chip is the attach control, the typed draft becomes the batch's
  // shared instruction, and the batch lands as ONE turn in THIS thread — which
  // is the point of having it here rather than only in the omnicomposer, where
  // every send starts a conversation detached from the one already going.
  const queuedComments = useQueuedComments();
  const selectedCommentCount = useSelectedCommentCount();
  const [commentsAttached, setCommentsAttached] = useState(false);
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const hasQueuedComments = selectedCommentCount > 0 && commentsAttached;

  /**
   * The one send. A live thread prompts (the server queues it behind an active
   * turn); an archived one type-to-resumes — the send respawns the agent and
   * reconnects the stored session, with the message riding the resume op as its
   * first turn (the server echoes it into the transcript immediately).
   *
   * Resolves to whether the message actually reached the agent, which the
   * queued-comment send needs: a batch reported as delivered is resolved and
   * dropped from the queue, so a resume that failed has to say so rather than
   * close comments on a turn that never ran.
   *
   * `.catch().finally()` rather than try/catch: React Compiler bails on some
   * TryStatement shapes, and the promise form is what the other composer uses.
   */
  const sendText = (
    text: string,
    /**
     * What the "new thread" fallback should carry when an archived thread's
     * resume fails. Defaults to the message itself.
     *
     * The queued-comment send passes null instead, because a failed hand-off
     * leaves every comment QUEUED: stashing the composed batch would run it on
     * the fresh thread and then let the same comments ride a later send too.
     * Null falls the fallback back to the draft — the reviewer's own words —
     * and re-attaching the still-queued batch there is the retry.
     */
    failureText: string | null = text,
  ): Promise<boolean> => {
    if (!archived) {
      client.prompt(info.threadId, text);
      // Sending re-engages the live edge even if the reader had scrolled up.
      scrollApiRef.current?.scrollToEnd();
      return Promise.resolve(true);
    }
    setResumePending(true);
    setResumeError(null);
    setFailedPrompt(null);
    scrollApiRef.current?.scrollToEnd();
    return client
      .resumeThread(info.threadId, text)
      .then(() => true)
      .catch((err) => {
        setResumeError(
          err instanceof ThreadResumeError
            ? err
            : new ThreadResumeError('internal', err instanceof Error ? err.message : String(err)),
        );
        setFailedPrompt(failureText);
        return false;
      })
      .finally(() => setResumePending(false));
  };

  const submit = (): void => {
    const text = draft.trim();
    // `canQueue` rides alongside `canPrompt`: a busy thread accepts a queued
    // message rather than refusing the send.
    if (!(canPrompt || canQueue)) return;
    // An attached batch IS the content, so the empty-draft gate doesn't apply to
    // it — the comments carry the ask even when nothing was typed for them.
    if (hasQueuedComments) {
      // `dispatchComments` reports every failure it knows about and returns an
      // empty batch, so nothing here should reject. If something upstream ever
      // does, the composer is already in the safe state — draft intact, batch
      // still attached, comments still queued — so this only has to keep the
      // rejection from disappearing.
      submitQueuedComments(text).catch((err) => {
        console.warn('[acp] queued-comment send rejected unexpectedly', err);
      });
      return;
    }
    if (text === '') return;
    void sendText(text);
    setDraft('');
  };

  /**
   * Dispatch the queued comments as one turn in this thread. The server
   * re-finds each anchor first (so a passage that moved is still found, and one
   * that is gone is flagged rather than silently retargeted), and the batch
   * resolves only if the send actually happened — a failed resume leaves every
   * comment queued, with the instruction still in the composer.
   *
   * Re-entrant sends are held off by `dispatchComments` itself, which guards the
   * one queue across every surface that drains it.
   */
  const submitQueuedComments = async (instruction: string): Promise<void> => {
    // A mid-turn send only reaches the server's MESSAGE queue, and both a
    // cancel and a terminal status drop that queue before the agent ever reads
    // it. Resolving there would close review work nobody has acted on — the one
    // failure the comment queue exists to prevent — so the batch stays queued
    // until a send that actually runs. The message itself is really sent, so
    // the composer still clears; the toast is what explains the two facts
    // sitting side by side.
    const queuedBehindTurn = canQueue;
    const shipped = await dispatchComments({
      resolve: !queuedBehindTurn,
      compose: (items) =>
        sendText(
          composeCommentBatchInstruction(
            items.map((item) => toCommentBatchItem(item.payload)),
            instruction,
          ),
          // Never stash the composed batch for the new-thread fallback — see
          // `sendText`'s `failureText`.
          null,
        ),
    });
    if (shipped.length === 0) return;
    if (queuedBehindTurn) {
      toast.info(
        t`Your comments are waiting behind the running turn — they stay queued until the agent picks the message up.`,
      );
    }
    setDraft('');
    // The batch detaches with the rest of the draft. Left on, the next message
    // would silently carry whatever had been queued since.
    setCommentsAttached(false);
    setCommentsExpanded(false);
  };

  const retryThread = (): void => {
    setRetryPending(true);
    void client
      .retryThread(info.threadId)
      .catch((err: unknown) => {
        toast.error(t`Couldn't start ${info.agent.name}: ${errorText(err)}`);
      })
      .finally(() => setRetryPending(false));
  };

  // Sign-in runs on the agent's live connection — on success the server's
  // `info` frame flips the thread to ready and the notice's action row goes
  // with it, so there is nothing to navigate to here.
  const authenticateThread = async (methodId: string): Promise<void> => {
    await client.authenticateThread(info.threadId, methodId);
  };

  const startFreshThread = (): void => {
    const prompt = failedPrompt ?? (draft.trim() === '' ? undefined : draft.trim());
    setResumeError(null);
    setFailedPrompt(null);
    void client
      .createThread({
        agent: { source: info.agent.source, id: info.agent.id },
        prompt,
      })
      .catch((err) => {
        // This create bypasses launchAgentThread, so no launch toast fires —
        // surface the failure inline the same way the resume path does, and
        // restore the prompt so the retry keeps the user's text.
        setResumeError(
          err instanceof ThreadResumeError
            ? err
            : new ThreadResumeError('internal', err instanceof Error ? err.message : String(err)),
        );
        setFailedPrompt(prompt ?? null);
      });
  };

  // Retry belongs to the failure the user is looking at — the LAST startup
  // failure, once. An allowlist rather than "not a prompt failure": a reason
  // added later is only retryable once someone decides it is, and a prompt
  // failure never is (that session is live, and re-sending IS the retry).
  let retryNoticeIndex = -1;
  if (canRetry && model !== null) {
    for (let index = model.items.length - 1; index >= 0; index -= 1) {
      const item = model.items[index];
      if (item?.kind === 'notice' && item.failure !== null && isRetryableFailure(item.failure)) {
        retryNoticeIndex = index;
        break;
      }
    }
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col text-gray-800 dark:text-gray-200"
      data-agent-thread-root=""
    >
      <ThreadHeader info={info} followFile={followFile} onToggleFollow={toggleFollow} />
      {model !== null && model.plan.length > 0 ? <PlanChecklist plan={model.plan} /> : null}
      {model === null || model.items.length === 0 ? (
        // No messages yet: the empty state centers itself via `h-full`, which needs
        // a plain definite-height block host. The scroller's managed flex layout
        // won't provide one, so only real transcripts go through the scroller.
        <div
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2 subtle-scrollbar scroll-fade-mask"
          data-testid="agent-thread-transcript"
        >
          <ThreadEmptyState status={status} archived={archived} agent={info.agent} />
        </div>
      ) : (
        // autoScroll = stick-to-bottom that yields to reader intent; last-anchor
        // reopens archived/resumed threads at the final turn. The bridge lifts the
        // scroller's imperative API up so send/resume can jump to the live edge.
        <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
          <ScrollToEndBridge apiRef={scrollApiRef} />
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport
              // Overrides the primitive's hardcoded "Messages" — this focusable
              // region is one agent's transcript, and its name must translate.
              aria-label={t`Agent transcript`}
              className="px-3 py-2 subtle-scrollbar scroll-fade-mask"
              data-testid="agent-thread-transcript"
            >
              <MessageScrollerContent className="gap-2 [&>[data-tool-call]+[data-tool-call]]:-mt-1">
                {model.items.map((item, index) => {
                  const id = transcriptItemId(item, index);
                  return (
                    <MessageScrollerItem
                      key={id}
                      messageId={id}
                      // Each item hosts its own flex column so per-message alignment
                      // (the user bubble's ml-auto hug-and-right) survives the wrapper
                      // the scroller requires for anchoring/measurement.
                      className="flex flex-col"
                      // A new user turn is the anchor the scroller peeks above.
                      scrollAnchor={item.kind === 'message' && item.role === 'user'}
                      // Re-hosts the adjacent-tool-call spacing selector on the wrapper.
                      data-tool-call={item.kind === 'tool_call' ? '' : undefined}
                    >
                      <ThreadItem
                        item={item}
                        threadId={info.threadId}
                        agent={info.agent}
                        // Thread liveness, not turn liveness: the server keeps an
                        // unanswered request answerable until its timeout even after
                        // the prompt settles (and some agents ask outside a turn) —
                        // only a dead thread makes answering impossible.
                        actionable={!archived && status !== 'exited' && status !== 'error'}
                        streaming={turnActive && index === model.items.length - 1}
                        terminals={model.terminals}
                        permissionsByToolCall={model.permissionsByToolCall}
                        showRetry={index === retryNoticeIndex}
                        retryPending={retryPending}
                        onRetry={retryThread}
                        // Sign-in belongs to the same notice Retry does, and
                        // only while the thread is still waiting on it.
                        showAuth={index === retryNoticeIndex && status === 'auth_required'}
                        onAuthenticate={authenticateThread}
                      />
                    </MessageScrollerItem>
                  );
                })}
                {turnActive ? (
                  status === 'awaiting_permission' ? (
                    <div
                      className="flex items-center gap-2 px-1 py-1 text-muted-foreground text-sm shimmer"
                      data-testid="agent-thread-awaiting-permission"
                    >
                      <span>{t`Waiting for your approval`}</span>
                    </div>
                  ) : (
                    <WorkingAvatar
                      status={workingStatusText(activeToolKind(model.items), thinkingLine)}
                      className="px-1 py-1"
                      testId="agent-thread-working"
                    />
                  )
                ) : status === 'installing' || status === 'spawning' ? (
                  // A resume respawning its agent: the optimistic message echo is
                  // already in the transcript above — show that the agent is on
                  // its way rather than a silent gap until the turn opens.
                  <div
                    className="flex items-center gap-2 px-1 py-1 text-muted-foreground text-sm"
                    data-testid="agent-thread-starting"
                  >
                    <Loader2
                      className="size-3.5 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    {/* `shimmer` sets `color: transparent`, which a container
                        would inherit into the spinner's currentColor stroke —
                        keep it scoped to the text. */}
                    <span className="shimmer">{t`Starting the agent…`}</span>
                  </div>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton direction="end" />
          </MessageScroller>
        </MessageScrollerProvider>
      )}
      {info.steer !== undefined && !archived ? (
        <div
          className="flex items-center gap-2 border-t bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs"
          data-testid="agent-thread-steer-pending"
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span className="shrink-0">{t`Steering — waiting for the current run to stop…`}</span>
          <span className="min-w-0 flex-1 truncate text-foreground/80">{info.steer.content}</span>
        </div>
      ) : null}
      {cancelStalled && turnActive ? (
        <div
          className="flex items-center gap-2 border-amber-500/30 border-t bg-amber-500/5 px-3 py-1.5 text-amber-700 text-xs dark:text-amber-400"
          data-testid="agent-thread-cancel-stalled"
        >
          <span className="flex-1">
            {t`The agent isn't stopping. Force stop closes this chat and quits the agent.`}
          </span>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="h-6 text-xs"
            onClick={() => client.closeThread(info.threadId)}
            data-testid="agent-thread-force-stop"
          >
            {t`Force stop`}
          </Button>
        </div>
      ) : null}
      {archived && resumeError !== null ? (
        <div
          className="flex items-center gap-2 border-amber-500/30 border-t bg-amber-500/5 px-3 py-1.5 text-amber-700 text-xs dark:text-amber-400"
          data-testid="agent-thread-resume-failed"
        >
          <span className="flex-1">
            {resumeError.code === 'resume-unsupported'
              ? t`${info.agent.name} can't continue this chat — the transcript is kept, but the agent session is gone.`
              : t`Couldn't resume this chat: ${resumeError.message}`}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 shrink-0 text-xs"
            onClick={startFreshThread}
            data-testid="agent-thread-resume-fallback-new"
          >
            {t`New chat with ${info.agent.name}`}
          </Button>
        </div>
      ) : null}
      <ThreadComposer
        info={info}
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={submit}
        canPrompt={canPrompt}
        canQueue={canQueue}
        turnActive={turnActive}
        cancelPending={cancelPending}
        onCancel={requestCancel}
        onSteer={requestSteer}
        status={status}
        archived={archived}
        resumePending={resumePending}
        usage={model?.tokenUsage ?? null}
        queuedComments={queuedComments}
        selectedCommentCount={selectedCommentCount}
        hasQueuedComments={hasQueuedComments}
        commentsExpanded={commentsExpanded}
        onAttachComments={() => {
          setCommentsAttached(true);
          // Deselection is sticky, so re-attaching has to re-check the queue —
          // otherwise this puts an empty batch on the message and the chip
          // bounces straight back to detached.
          selectAllQueued();
        }}
        onToggleCommentsExpanded={() => setCommentsExpanded((open) => !open)}
        onDismissComments={() => {
          setCommentsAttached(false);
          setCommentsExpanded(false);
        }}
      />
    </div>
  );
}

function ThreadHeader({
  info,
  followFile,
  onToggleFollow,
}: {
  info: ThreadInfo;
  followFile: boolean;
  onToggleFollow: () => void;
}): ReactNode {
  const { t } = useLingui();
  return (
    <div className="flex items-center gap-2 px-3 pb-1.5 pt-0">
      <span className="min-w-0 truncate font-medium text-1sm">{info.title}</span>
      {info.agent.version !== undefined && info.agent.version !== '' ? (
        // Which build answered. OK launches the registry-pinned version, which
        // is routinely not the one the user's own terminal runs — without this
        // a version-specific bug has no visible attribution.
        <span
          className="shrink-0 text-[10px] text-muted-foreground tabular-nums"
          title={t`${info.agent.name} version ${info.agent.version}`}
          data-testid="agent-thread-agent-version"
        >
          {info.agent.version}
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              // On/off is carried by the pressed-looking accent fill (not a subtle
              // gray shift), so the icon stays constant and just fills when active.
              className={cn(
                'rounded-md',
                followFile
                  ? 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'
                  : 'text-muted-foreground',
              )}
              aria-pressed={followFile}
              aria-label={t`Follow the agent's edits`}
              onClick={onToggleFollow}
              data-testid="agent-thread-follow-toggle"
            >
              <MousePointer2 className="size-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {followFile ? t`Following the agent's edits` : t`Follow the agent's edits`}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

type SelectConfigOption = Extract<SessionConfigOption, { type: 'select' }>;

function currentSelectEntry(
  option: SelectConfigOption,
): { value: string; name: string } | undefined {
  for (const entry of option.options) {
    if ('value' in entry) {
      if (entry.value === option.currentValue) return entry;
      continue;
    }
    const current = entry.options.find((candidate) => candidate.value === option.currentValue);
    if (current !== undefined) return current;
  }
  return undefined;
}

/**
 * A raw wire id shown because the advertised list doesn't contain the current
 * value — make it read like a label ("bypassPermissions" → "Bypass
 * Permissions") rather than a camelCase/kebab token.
 */
function humanizeValueId(id: string): string {
  const spaced = id
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function selectOptionName(option: SelectConfigOption): string {
  return currentSelectEntry(option)?.name ?? humanizeValueId(option.currentValue);
}

/**
 * The current value as the collapsed row / trigger should read it: the
 * adapter's own display name, except where a bare "Default" can be resolved
 * into what it actually is — via the hint table, or via the adapter's own
 * data when the default entry's description names a concrete sibling.
 */
function selectOptionSummary(agentId: string, option: SelectConfigOption): string {
  const entry = currentSelectEntry(option);
  if (entry === undefined) return humanizeValueId(option.currentValue);
  return (
    configValueHint(agentId, option.id, entry.value) ??
    resolveDefaultOptionLabel(option) ??
    entry.name
  );
}

function hasSelectValues(option: SelectConfigOption): boolean {
  return option.options.some((entry) => ('value' in entry ? true : entry.options.length > 0));
}

/** Every selectable value, flattened across groups. */
function flattenSelectValues(option: SelectConfigOption): Array<{ id: string; name: string }> {
  const flat: Array<{ id: string; name: string }> = [];
  for (const entry of option.options) {
    if ('value' in entry) flat.push({ id: entry.value, name: entry.name });
    else for (const grouped of entry.options) flat.push({ id: grouped.value, name: grouped.name });
  }
  return flat;
}

/**
 * The one mode surface this agent exposes, normalized. Agents advertise modes
 * either as a mode-category config option (current) or as `SessionModeState`
 * (legacy `session/set_mode`) — `configId` says which, so callers apply a mode
 * without re-deriving the branch. Single source of truth for the settings menu
 * and the mode offer, which must agree on what "the current mode" is.
 */
interface ModeSurface {
  /** Config-option id, or null when the agent uses legacy `session/set_mode`. */
  configId: string | null;
  currentId: string;
  currentName: string;
  values: ReadonlyArray<{ id: string; name: string }>;
}

function deriveModeSurface(info: ThreadInfo): ModeSurface | null {
  const modeOption = (info.configOptions ?? []).find(
    (option): option is SelectConfigOption =>
      option.type === 'select' && option.category === 'mode' && hasSelectValues(option),
  );
  if (modeOption !== undefined) {
    return {
      configId: modeOption.id,
      currentId: modeOption.currentValue,
      currentName: selectOptionName(modeOption),
      values: flattenSelectValues(modeOption),
    };
  }
  // `modes` predates generalized config options. Keep it as a fallback, but
  // never duplicate a mode the agent already exposes in `configOptions`.
  const modes = info.modes;
  if (modes != null && modes.availableModes.length > 1) {
    return {
      configId: null,
      currentId: modes.currentModeId,
      currentName:
        modes.availableModes.find((mode) => mode.id === modes.currentModeId)?.name ??
        humanizeValueId(modes.currentModeId),
      values: modes.availableModes.map((mode) => ({ id: mode.id, name: mode.name })),
    };
  }
  return null;
}

/** One stable trigger for every setting an ACP agent advertises. */
function AgentSettingsPopover({ info }: { info: ThreadInfo }): ReactNode {
  const { t } = useLingui();
  const client = getAgentThreadClient();
  const settingsKey = agentSettingsKey(info.agent);
  const applyConfig = (option: SessionConfigOption, value: string | boolean): void => {
    client.setConfigOption(info.threadId, option.id, value);
    // Every pick carries to the next thread of this agent, modes included — a
    // mode advertised as a config option needs no special case. What keeps a
    // restored permissive mode honest is the accent below, not withholding it.
    rememberAgentConfigOption(settingsKey, option.id, value);
  };
  const configOptions = (info.configOptions ?? []).filter(
    (option) => option.type === 'boolean' || hasSelectValues(option),
  );
  const modeSurface = deriveModeSurface(info);
  const showLegacyModes = modeSurface !== null && modeSurface.configId === null;
  if (configOptions.length === 0 && !showLegacyModes) return null;

  const legacyModeName = showLegacyModes ? modeSurface.currentName : undefined;
  // Modes carry across threads like everything else, so the thing worth
  // marking is not "this was restored" but "this mode lets the agent act
  // without asking" — true whether it was restored or just picked. Best-effort
  // name matching; see `permissive-mode.ts` for why a hint is the right bar.
  const permissiveMode =
    modeSurface !== null &&
    isPermissiveMode({ id: modeSurface.currentId, name: modeSurface.currentName });

  const primarySelect =
    configOptions.find(
      (option): option is SelectConfigOption =>
        option.type === 'select' && option.category === 'model',
    ) ?? configOptions.find((option): option is SelectConfigOption => option.type === 'select');
  const triggerText =
    primarySelect !== undefined
      ? selectOptionSummary(info.agent.id, primarySelect)
      : (legacyModeName ?? t`Settings`);
  const accentTooltip =
    permissiveMode && modeSurface !== null
      ? t`${modeSurface.currentName} lets ${info.agent.name} act without asking`
      : t`Agent settings`;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-6 max-w-48 gap-1 rounded-md pl-1.5 pr-1! text-xs"
              aria-label={accentTooltip}
              data-testid="agent-thread-settings"
            >
              {/* A mode that lets the agent act unprompted should never be in
                  force unnoticed — least of all one carried over from an
                  earlier thread. Kept small and low-contrast: present, not
                  alarming. */}
              {permissiveMode ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-amber-500 ring-[3px] ring-amber-500/15 dark:bg-amber-400 dark:ring-amber-400/15"
                  data-testid="agent-thread-mode-accent"
                  aria-hidden="true"
                />
              ) : null}
              <span className="truncate">{triggerText}</span>
              <ChevronDown className="size-3.5" data-icon="inline-end" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{accentTooltip}</TooltipContent>
      </Tooltip>
      {/* Hybrid menu: each multi-value select is a submenu row summarizing its
          current value; a lone boolean stays inline. The compact top level scales
          as agents expose more (and longer-described) options — the sprawl lives
          in the submenus instead of stretching one flat panel. */}
      <DropdownMenuContent align="end" className="w-60" data-testid="agent-thread-settings-popover">
        {configOptions.map((option) =>
          option.type === 'select' ? (
            <ConfigSelectSub
              key={option.id}
              agentId={info.agent.id}
              option={option}
              onSelect={(value) => applyConfig(option, value)}
            />
          ) : (
            <ConfigBooleanItem
              key={option.id}
              option={option}
              onCheckedChange={(value) => applyConfig(option, value)}
            />
          ),
        )}
        {showLegacyModes ? (
          <ConfigSelectSub
            agentId={info.agent.id}
            option={{
              id: 'legacy-mode',
              name: t`Agent mode`,
              category: 'mode',
              type: 'select',
              currentValue: modeSurface.currentId,
              options: modeSurface.values.map((mode) => ({ value: mode.id, name: mode.name })),
            }}
            onSelect={(modeId) => {
              client.setMode(info.threadId, modeId);
              rememberAgentMode(settingsKey, modeId);
            }}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConfigSelectSub({
  agentId,
  option,
  onSelect,
}: {
  agentId: string;
  option: SelectConfigOption;
  onSelect: (valueId: string) => void;
}): ReactNode {
  // A value the adapter describes keeps its description; a bare known
  // "Default" gets the hint table's resolution as its secondary line.
  const withHint = <E extends { value: string; name: string; description?: string | null }>(
    entry: E,
  ): E =>
    entry.description
      ? entry
      : { ...entry, description: configValueHint(agentId, option.id, entry.value) ?? undefined };
  const entries: ReadonlyArray<(typeof option.options)[number]> = option.options;
  const flat = entries.filter(
    (entry): entry is Extract<(typeof entries)[number], { value: string }> => 'value' in entry,
  );
  const groups = entries.filter(
    (entry): entry is Extract<(typeof entries)[number], { group: string }> => 'group' in entry,
  );
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2" data-testid={`agent-thread-config-${option.id}`}>
        <span className="min-w-0 flex-1 truncate">{option.name}</span>
        <span className="max-w-[11rem] truncate text-1sm text-muted-foreground">
          {selectOptionSummary(agentId, option)}
        </span>
      </DropdownMenuSubTrigger>
      {/* Cap the height so a long option list (e.g. the pr-review personas)
          scrolls instead of spanning the whole window; still never exceeds the
          viewport-fit height Radix computes. overscroll-contain stops the scroll
          from chaining to the page at the list boundaries. */}
      <DropdownMenuSubContent className="max-h-[min(22rem,var(--radix-dropdown-menu-content-available-height))] max-w-72 overscroll-contain">
        {/* Name the flyout — orients you once a long list scrolls the parent row
            out of view. Skip a group label that just repeats it. */}
        <DropdownMenuLabel>{option.name}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={option.currentValue} onValueChange={onSelect}>
          {flat.map((entry) => (
            <ConfigRadioItem key={entry.value} entry={withHint(entry)} />
          ))}
          {groups.map((group) => (
            <Fragment key={group.group}>
              {group.name !== option.name ? (
                <DropdownMenuLabel className="font-normal text-muted-foreground">
                  {group.name}
                </DropdownMenuLabel>
              ) : null}
              {group.options.map((entry) => (
                <ConfigRadioItem key={entry.value} entry={withHint(entry)} />
              ))}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ConfigRadioItem({
  entry,
}: {
  entry: { value: string; name: string; description?: string | null };
}): ReactNode {
  return (
    <DropdownMenuRadioItem
      value={entry.value}
      className="items-start"
      data-testid={`agent-thread-config-option-${entry.value}`}
    >
      {/* min-w-0 lets the column shrink below the name's intrinsic width so the
          truncate/clamp actually clip instead of stretching the submenu. */}
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{entry.name}</span>
        {entry.description ? (
          // Persona descriptions are long agent-routing prompts (spawn rules,
          // example blocks); clamp as a safety net so a verbose entry can't
          // stretch the submenu — the gist is front-loaded anyway.
          <span className="line-clamp-2 text-1sm text-muted-foreground">{entry.description}</span>
        ) : null}
      </div>
    </DropdownMenuRadioItem>
  );
}

function ConfigBooleanItem({
  option,
  onCheckedChange,
}: {
  option: Extract<SessionConfigOption, { type: 'boolean' }>;
  onCheckedChange: (value: boolean) => void;
}): ReactNode {
  // A real `menuitemcheckbox` (keyboard-roving, `aria-checked`) owns the toggle,
  // so the row is fully accessible. The default checkmark is hidden and a
  // decorative Switch stands in for it — the Switch is `aria-hidden` +
  // pointer-events-none, so it never becomes a second (invalid) menu control.
  return (
    <DropdownMenuCheckboxItem
      checked={option.currentValue}
      onCheckedChange={onCheckedChange}
      // Keep the menu open on toggle so several settings can be flipped in one visit.
      onSelect={(event) => event.preventDefault()}
      className="items-start justify-between gap-4 pr-2 [&_[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
      data-testid={`agent-thread-config-${option.id}`}
    >
      <div className="flex min-w-0 flex-col">
        <span>{option.name}</span>
        {option.description ? (
          <span className="text-1sm text-muted-foreground">{option.description}</span>
        ) : null}
      </div>
      <Switch
        checked={option.currentValue}
        size="sm"
        aria-hidden="true"
        tabIndex={-1}
        className="pointer-events-none mt-0.5"
      />
    </DropdownMenuCheckboxItem>
  );
}

/**
 * A minimal chat-shaped placeholder shown while a stored conversation resumes:
 * a sent bubble on the right, an agent reply block on the left, twice over.
 * Mirrors the transcript's real structure (skeleton-for-structured-content)
 * without faking avatars, timestamps, or tool cards. The visible bars are
 * decorative; a screen-reader status announces the load separately.
 */
function ThreadTranscriptSkeleton(): ReactNode {
  const { t } = useLingui();
  // Populate the live region AFTER mount so the status reads as a *change* — a
  // region that already holds its text on first render is often not announced.
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    setAnnounced(t`Loading the chat`);
  }, [t]);
  return (
    <div className="flex flex-col gap-6 pt-2">
      <div aria-live="polite" className="sr-only" role="status">
        {announced}
      </div>
      <div aria-hidden="true" className="flex flex-col gap-6">
        <div className="flex justify-end">
          <Skeleton className="h-12 w-3/5 rounded-2xl rounded-br-xs" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
        <div className="flex justify-end">
          <Skeleton className="h-8 w-2/5 rounded-2xl rounded-br-xs" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3.5 w-5/6" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      </div>
    </div>
  );
}

function ThreadEmptyState({
  status,
  archived,
  agent,
}: {
  status: ThreadInfo['status'];
  archived: boolean;
  agent: ThreadInfo['agent'];
}): ReactNode {
  const { t } = useLingui();
  const agentName = agentDisplayName(agent.name);

  // Resuming a stored conversation: show the transcript's shape, not a bare line.
  if (archived) {
    return <ThreadTranscriptSkeleton />;
  }

  // Ready and idle: a quiet, faded agent mark + "Ask <agent>". Deliberately
  // minimal — no starter-prompt scaffolding (project shapes vary too much to
  // suggest reliably) and no illustration (chat surfaces stay text/icon-first).
  if (status === 'ready') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <RegisteredAgentIcon
          agentId={agent.id}
          iconUrl={agent.iconUrl}
          className="size-12 opacity-25 grayscale"
        />
        <p className="text-muted-foreground text-sm">{t`Ask ${agentName}`}</p>
      </div>
    );
  }

  // Auth is an action prompt, not a wait — keep a plain line pointing at the
  // sign-in notice rendered below the transcript.
  if (status === 'auth_required') {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-muted-foreground text-sm">
        {t`This agent needs you to sign in first — see the notice below.`}
      </div>
    );
  }

  // Agent still coming up: the agent mark breathes and the status line shimmers
  // so the wait reads as "working". `shimmer` is a text-clipped gradient sweep
  // with no effect on SVG/img, so the icon gets `animate-pulse` instead — its
  // implicit 0%/100% keyframes take the element's own `opacity-25`, giving a
  // subtle 0.25→0.5 breathe.
  const loadingMessage =
    status === 'installing'
      ? t`Installing ${agentName}…`
      : status === 'spawning'
        ? t`Starting ${agentName}…`
        : t`Connecting to ${agentName}…`;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <RegisteredAgentIcon
        agentId={agent.id}
        iconUrl={agent.iconUrl}
        className="size-12 animate-pulse opacity-25 grayscale motion-reduce:animate-none"
      />
      <p className="shimmer text-sm">{loadingMessage}</p>
    </div>
  );
}

function PlanChecklist({ plan }: { plan: { content: string; status?: string }[] }): ReactNode {
  const { t } = useLingui();
  const [open, setOpen] = useState(true);
  const done = plan.filter((p) => p.status === 'completed').length;
  return (
    <div className="border-border/60 border-b bg-muted/30 px-3 py-1.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto w-full justify-start gap-1.5 p-0 font-medium text-muted-foreground text-xs hover:bg-transparent"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3.5" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden="true" />
        )}
        <span>{t`Plan (${done}/${plan.length})`}</span>
      </Button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-0.5">
          {plan.map((entry, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: plan is a positional list
              key={index}
              className={cn(
                'flex items-start gap-1.5 text-xs',
                entry.status === 'completed' && 'text-muted-foreground line-through',
              )}
            >
              <span aria-hidden="true">{entry.status === 'completed' ? '☑' : '☐'}</span>
              <span>{entry.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// The scroller's imperative API only exists inside its Provider; this bridge
// publishes it to a parent-owned ref so send/resume handlers (which live above
// the Provider) can call scrollToEnd.
function ScrollToEndBridge({
  apiRef,
}: {
  apiRef: RefObject<ReturnType<typeof useMessageScroller> | null>;
}): null {
  const api = useMessageScroller();
  useEffect(() => {
    apiRef.current = api;
    return () => {
      apiRef.current = null;
    };
  }, [api, apiRef]);
  return null;
}

function ThreadItem({
  item,
  threadId,
  agent,
  actionable,
  streaming,
  terminals,
  permissionsByToolCall,
  showRetry,
  retryPending,
  onRetry,
  showAuth,
  onAuthenticate,
}: {
  item: RenderedItem;
  threadId: string;
  agent: ThreadInfo['agent'];
  /** The thread can still take answers (live agent, not archived/dead). */
  actionable: boolean;
  /** This item is the transcript tail of an active turn (still growing). */
  streaming: boolean;
  terminals: Record<string, RenderedTerminal>;
  permissionsByToolCall: Record<string, RenderedPermission>;
  /** This notice is the one that offers Retry (at most one per transcript). */
  showRetry: boolean;
  retryPending: boolean;
  onRetry: () => void;
  /** …and the one that offers sign-in, while the thread still needs it. */
  showAuth: boolean;
  onAuthenticate: (methodId: string) => Promise<void>;
}): ReactNode {
  switch (item.kind) {
    case 'message':
      return <MessageBubble item={item} streaming={streaming} />;
    case 'tool_call':
      return (
        <ToolCallCard
          call={item}
          terminals={terminals}
          permission={permissionsByToolCall[item.toolCallId]}
        />
      );
    case 'permission':
      // A settled prompt whose gated call is in the transcript is shown on that
      // call's row instead, so this card would only restate it. Pending prompts
      // always render — they are the thing you have to act on.
      return item.mergedIntoToolCall && item.resolved !== null ? null : (
        <PermissionPrompt item={item} threadId={threadId} actionable={actionable} />
      );
    case 'runtime_consent':
      return <RuntimeConsentPrompt item={item} threadId={threadId} />;
    case 'notice':
      return (
        <ThreadNotice
          item={item}
          agentName={agentDisplayName(agent.name)}
          showRetry={showRetry}
          retryPending={retryPending}
          onRetry={onRetry}
          showAuth={showAuth}
          onAuthenticate={onAuthenticate}
        />
      );
  }
}

/**
 * A thinking run, collapsed to one line. Collapsed even while streaming — the
 * tool-call card's comment records why expand-while-running fails here (the
 * fold-up yanks the bottom-pinned transcript), and the working avatar already
 * signals liveness. The preview shows the tail line while streaming (it moves,
 * so the row reads as live) and the head line once settled (it reads as the
 * summary).
 */
function ThoughtBlock({
  item,
  streaming,
}: {
  item: Extract<RenderedItem, { kind: 'message' }>;
  streaming: boolean;
}): ReactNode {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const lines = item.text.split('\n').filter((line) => line.trim().length > 0);
  const preview = (streaming ? lines[lines.length - 1] : lines[0]) ?? '';
  return (
    <div data-testid="agent-thread-thought">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto w-full justify-start gap-1 px-0 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide hover:bg-transparent"
        onClick={() => setOpen((value) => !value)}
        // Disclosure per APG: `aria-expanded` alone — no `aria-controls`,
        // whose IDREF would dangle while the body is unmounted.
        aria-expanded={open}
        data-testid="agent-thread-thought-toggle"
      >
        {open ? (
          <ChevronDown className="size-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3" aria-hidden="true" />
        )}
        {t`Thinking`}
        {open ? null : (
          <span className="min-w-0 flex-1 truncate text-left font-normal text-xs normal-case italic tracking-normal">
            {preview}
          </span>
        )}
      </Button>
      {open ? (
        // Thoughts carry markdown like any other agent output, so they parse —
        // otherwise an agent's bold summary line shows its literal `**`. But a
        // thought must never compete with the reply for attention, so emphasis
        // is flattened to one quiet weight and size: the markup still
        // structures the text, it just can't shout. The flattening classes
        // must stay on the element that directly wraps AgentMarkdown, whose
        // own code-size rule deliberately yields to them.
        <div className="px-1 text-muted-foreground text-xs italic **:font-normal! **:text-xs!">
          <AgentMarkdown text={item.text} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A failure the user has to read: what broke, in OK's own words, with the
 * agent's message quoted underneath and the wire payload behind a disclosure
 * so a JSON blob never becomes the headline.
 */
function ThreadNotice({
  item,
  agentName,
  showRetry,
  retryPending,
  onRetry,
  showAuth,
  onAuthenticate,
}: {
  item: Extract<RenderedItem, { kind: 'notice' }>;
  agentName: string;
  showRetry: boolean;
  retryPending: boolean;
  onRetry: () => void;
  showAuth: boolean;
  onAuthenticate: (methodId: string) => Promise<void>;
}): ReactNode {
  const { t } = useLingui();
  const [showDetail, setShowDetail] = useState(false);
  const [authPending, setAuthPending] = useState<string | null>(null);
  const failure = item.failure;
  const authMethods =
    showAuth && failure !== null && failure.reason === 'auth-required'
      ? (failure.authMethods ?? [])
      : [];
  // `env_var` / `terminal` methods are completed in the user's own shell or
  // environment — OK can name them, but the protocol gives it no way to carry
  // out the sign-in, so they get no button. Retry below is how the user says
  // they did it. Everything else (including the default agent-driven kind) is
  // an `authenticate` call OK can make itself.
  const signInMethods = authMethods.filter((m) => m.kind !== 'terminal' && m.kind !== 'env_var');
  const manualMethods = authMethods.filter((m) => m.kind === 'terminal' || m.kind === 'env_var');
  const signIn = (methodId: string): void => {
    setAuthPending(methodId);
    void onAuthenticate(methodId)
      .catch((err: unknown) => {
        toast.error(t`Sign-in failed: ${errorText(err)}`);
      })
      .finally(() => setAuthPending(null));
  };
  // Exhaustive by construction: a new `reason` on the wire fails the build
  // here instead of silently rendering the prompt-failure copy.
  const failureHeadline = (reason: ThreadFailureDetail['reason']): string => {
    switch (reason) {
      case 'auth-required':
        return t`Sign in to ${agentName} to continue.`;
      case 'connect':
        return t`${agentName} couldn't start.`;
      case 'session-setup':
        return t`${agentName} couldn't start a conversation.`;
      case 'prompt':
        return t`Your message didn't reach ${agentName}.`;
      default: {
        const exhaustive: never = reason;
        return String(exhaustive);
      }
    }
  };
  const headline = failure === null ? null : failureHeadline(failure.reason);
  return (
    <div
      className={cn(
        'rounded-md border px-2 py-1.5 text-xs',
        item.tone === 'error'
          ? 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400'
          : 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400',
      )}
      data-testid="agent-thread-notice"
    >
      {failure === null ? (
        item.text
      ) : (
        <>
          <p>{headline}</p>
          {failure.agentMessage !== undefined && failure.agentMessage !== '' ? (
            <p className="mt-1 opacity-80">{failure.agentMessage}</p>
          ) : null}
          {failure.machineDetail !== undefined && failure.machineDetail !== '' ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 h-auto p-0 text-[11px] underline hover:bg-transparent"
                onClick={() => setShowDetail((open) => !open)}
                aria-expanded={showDetail}
                data-testid="agent-thread-notice-details-toggle"
              >
                {showDetail ? t`Hide details` : t`Show details`}
              </Button>
              {showDetail ? (
                <pre
                  className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[10px] opacity-70"
                  data-testid="agent-thread-notice-details"
                >
                  {failure.machineDetail}
                </pre>
              ) : null}
            </>
          ) : null}
          {manualMethods.length > 0 ? (
            <ul className="mt-1.5 flex flex-col gap-0.5 opacity-80">
              {manualMethods.map((method) => (
                <li key={method.id} data-testid="agent-thread-auth-manual">
                  {method.description !== undefined && method.description !== ''
                    ? `${method.name} — ${method.description}`
                    : method.name}
                </li>
              ))}
            </ul>
          ) : null}
          {signInMethods.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {signInMethods.map((method) => (
                <Button
                  key={method.id}
                  type="button"
                  size="sm"
                  className="h-6 text-xs"
                  disabled={authPending !== null}
                  onClick={() => signIn(method.id)}
                  data-testid="agent-thread-auth-method"
                  data-auth-method-id={method.id}
                >
                  {authPending === method.id ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                  ) : null}
                  {/* One method is the whole choice, so the button says what it
                      does; several are a menu, and the names are the choice. */}
                  {signInMethods.length === 1 ? t`Sign in with ${method.name}` : method.name}
                </Button>
              ))}
            </div>
          ) : null}
          {showRetry ? (
            <div className="mt-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                disabled={retryPending}
                onClick={onRetry}
                data-testid="agent-thread-retry"
              >
                {retryPending ? (
                  <>
                    <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                    {t`Retrying…`}
                  </>
                ) : (
                  t`Retry`
                )}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function MessageBubble({
  item,
  streaming,
}: {
  item: Extract<RenderedItem, { kind: 'message' }>;
  streaming?: boolean;
}): ReactNode {
  if (item.role === 'thought') {
    return <ThoughtBlock item={item} streaming={streaming === true} />;
  }
  const isUser = item.role === 'user';
  return (
    <div
      className={cn(
        'wrap-break-word text-sm text-foreground',
        isUser
          ? // Sent-message bubble: light-gray fill, right-aligned, with the
            // squared bottom-right corner (the sender-side "tail"). Extra bottom
            // margin (on top of the transcript's gap-2) enlarges only the turn
            // boundary — the gap before the agent's response starts — while the
            // response's own items (reply text + its tool calls) stay tight.
            'my-3 ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-xs bg-muted px-3 py-1.5'
          : // Agent reply reads as full-width prose — no bubble, no fill.
            'w-full',
      )}
      data-testid={isUser ? 'agent-thread-user-message' : 'agent-thread-agent-message'}
    >
      {isUser ? item.text : <AgentMarkdown text={item.text} />}
    </div>
  );
}

/**
 * The adapter-reported raw tool input, pretty-printed for the card body —
 * "what exactly is it about to run". Null for absent/empty inputs (nothing
 * worth a block) and bounded so a huge argument can't flood the transcript.
 */
function formatRawInput(rawInput: unknown): string | null {
  if (rawInput === undefined || rawInput === null) return null;
  if (
    typeof rawInput === 'object' &&
    !Array.isArray(rawInput) &&
    Object.keys(rawInput).length === 0
  ) {
    return null;
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(rawInput, null, 1);
  } catch {
    return null;
  }
  if (text === undefined) return null;
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

/**
 * Drop a markdown fence that wraps an entire tool-output block. The block is
 * rendered literally — tool output frequently isn't markdown, and a renderer
 * would mangle it — so an agent that fences its output leaves its backticks
 * on screen. Only a fence enclosing the WHOLE block is removed; one that opens
 * partway through is part of the output.
 */
function stripWrappingFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return text;
  const lines = trimmed.split('\n');
  // The opening line may carry an info string (```json), so drop it entirely.
  if (lines.length < 2 || lines[lines.length - 1]?.trim() !== '```') return text;
  return lines.slice(1, -1).join('\n');
}

function ToolCallCard({
  call,
  terminals,
  permission,
}: {
  call: RenderedToolCall;
  terminals: Record<string, RenderedTerminal>;
  /** The prompt that gated this call, when one did. */
  permission?: RenderedPermission;
}): ReactNode {
  // Collapsed by default, failures excepted. Opening a call while it runs and
  // folding it up a beat later showed a body too briefly to read, and the fold
  // yanked the bottom-pinned transcript. Starting closed removes that motion
  // entirely; the spinner already says the call is live, and anything you
  // actually want to watch is one click away. An error is the one body worth
  // showing unasked.
  const [open, setOpen] = useState(call.status === 'failed');
  const userToggledRef = useRef(false);
  const prevStatusRef = useRef(call.status);
  const [completedLive, setCompletedLive] = useState(false);
  const [checkVisible, setCheckVisible] = useState(false);
  // Keyed on the live transition, never mount state: a replayed transcript
  // mounts every call already settled, and would otherwise flash a hundred
  // checks at once and expand every historical failure.
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = call.status;
    if (prev === call.status) return;
    if (call.status === 'failed' && !userToggledRef.current) setOpen(true);
    if (prev !== 'completed' && call.status === 'completed') {
      setCompletedLive(true);
      setCheckVisible(true);
      const timer = setTimeout(() => setCheckVisible(false), COMPLETION_CHECK_MS);
      return () => clearTimeout(timer);
    }
  }, [call.status]);
  const toggleOpen = (): void => {
    userToggledRef.current = true;
    setOpen((value) => !value);
  };
  const display = describeToolCall(call);
  const Icon = TOOL_ICONS[display.glyph];
  const callTerminals = call.terminalIds
    .map((id) => terminals[id])
    .filter((terminal): terminal is RenderedTerminal => terminal !== undefined);
  const rawInput = formatRawInput(call.rawInput);
  const hasBody =
    call.diffs.length > 0 ||
    call.content.length > 0 ||
    call.locations.length > 0 ||
    callTerminals.length > 0 ||
    rawInput !== null;
  const expanded = open && hasBody;
  const row = (
    <>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate">{display.text}</span>
      {/* One auto margin, not two: sibling `ml-auto`s split the free space
          between them instead of the first absorbing it, which floated the
          marks apart mid-row. */}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <PermissionRefusalMark permission={permission} status={call.status} />
        <ToolStatusIndicator
          status={call.status}
          completedLive={completedLive}
          checkVisible={checkVisible}
        />
      </span>
    </>
  );
  return (
    <div
      // The box earns its way in only when there is something inside it. A
      // collapsed row is a line of text, so a run of calls reads as a list
      // rather than a ladder of empty rectangles.
      className={cn('text-xs', expanded && 'rounded-md border border-border/60')}
      data-tool-call=""
      data-testid="agent-thread-tool-call"
    >
      {hasBody ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto w-full justify-start gap-1.5 rounded-md px-2 py-1.5 font-normal"
          onClick={toggleOpen}
          aria-expanded={open}
        >
          {row}
        </Button>
      ) : (
        // Nothing to reveal — render the row as text rather than a control that
        // only ever reports itself disabled.
        <div className="flex w-full items-center gap-1.5 px-2 py-1.5">{row}</div>
      )}
      {expanded ? (
        <div className="flex flex-col gap-1.5 border-border/60 border-t px-2 py-1.5">
          {call.diffs.map((diff, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: diffs are positional within a card
            <InlineDiff key={index} diff={diff} />
          ))}
          {callTerminals.map((terminal) => (
            <TerminalBlock key={terminal.terminalId} terminal={terminal} />
          ))}
          {call.content.map((text, index) => (
            <pre
              // biome-ignore lint/suspicious/noArrayIndexKey: content blocks are positional
              key={index}
              className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/50 px-2 py-1 font-mono text-[11px]"
            >
              {stripWrappingFence(text)}
            </pre>
          ))}
          {rawInput !== null ? <RawInputBlock text={rawInput} /> : null}
          {call.locations.length > 0 ? (
            <div className="flex flex-wrap gap-1 text-muted-foreground">
              {call.locations.map((loc, index) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: locations are positional
                  key={index}
                  className="rounded bg-muted/50 px-1 py-0.5 font-mono text-[11px]"
                >
                  {loc.path}
                  {loc.line !== undefined ? `:${loc.line}` : ''}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Agents name their refusal option "Reject" and their grant "Allow", so pinning
 * that onto "Denied"/"Approved" says the same word twice. Keep the name only
 * when it carries something the outcome doesn't — the persistence in "Always
 * deny", say.
 */
const OUTCOME_SYNONYM_NAMES = new Set([
  'accept',
  'allow',
  'approve',
  'decline',
  'deny',
  'no',
  'ok',
  'reject',
  'yes',
]);

function informativeOptionName(name: string | null): string | null {
  if (name === null) return null;
  const normalized = name.trim().toLocaleLowerCase();
  return normalized === '' || OUTCOME_SYNONYM_NAMES.has(normalized) ? null : name;
}

/**
 * One phrasing of a settled permission, shared by the standalone card and the
 * mark on a tool call's row so the two can never drift apart.
 */
function usePermissionOutcomeLabel(): (outcome: PermissionOutcome) => string | null {
  const { t } = useLingui();
  return (outcome) => {
    if (outcome === null) return null;
    // `dismissed` covers timeout, Stop-cancel, and agent exit alike — don't
    // claim a specific cause the event doesn't carry.
    if (outcome.kind === 'dismissed') return t`Not answered`;
    const optionName = informativeOptionName(outcome.optionName);
    if (outcome.kind === 'approved') {
      if (outcome.auto) return t`Auto-approved`;
      return optionName !== null ? t`Approved — ${optionName}` : t`Approved`;
    }
    if (outcome.auto) return t`Auto-denied`;
    return optionName !== null ? t`Denied — ${optionName}` : t`Denied`;
  };
}

/**
 * The outcome of the prompt that gated this call, carried on the call's own row
 * rather than as a sibling card restating the tool name beside it.
 *
 * An approval leaves no trace at all: the call ran, which is the whole message,
 * and every comparable agent panel drops the prompt once answered rather than
 * minting a permanent "you allowed this" marker. Only a refusal changed what
 * happened — and it says so in words, since a lone glyph gives the reader no
 * way to learn what it means.
 */
function PermissionRefusalMark({
  permission,
  status,
}: {
  permission?: RenderedPermission;
  status: RenderedToolCall['status'];
}): ReactNode {
  const outcomeLabel = usePermissionOutcomeLabel();
  if (permission === undefined || !permission.mergedIntoToolCall) return null;
  const outcome = resolvePermissionOutcome(permission);
  if (outcome === null || outcome.kind === 'approved') return null;
  // A refused call almost always lands as `failed`, whose badge and body
  // already say it didn't run and why. Speak only where nothing else does —
  // an agent that leaves the call unfinished after a refusal.
  if (status === 'failed') return null;
  return (
    <span className="shrink-0 text-muted-foreground" data-testid="agent-thread-tool-permission">
      {outcomeLabel(outcome)}
    </span>
  );
}

/**
 * Status by exception. Completion is the expected outcome, so a settled call
 * shows nothing — a badge on every row buries the one row that failed. Live
 * calls spin; a call that finishes while you are watching flashes a check that
 * then fades, so the acknowledgement rides the transition instead of becoming
 * permanent chrome. The check keeps its box after fading to opacity 0 so the
 * row does not reflow underneath the pointer.
 *
 * Every state keeps its label in the a11y tree: dropping the visible badge is a
 * density decision, not a reason to withhold status from assistive tech.
 */
function ToolStatusIndicator({
  status,
  completedLive,
  checkVisible,
}: {
  status: RenderedToolCall['status'];
  /** This call transitioned to completed while mounted (not a replayed row). */
  completedLive: boolean;
  checkVisible: boolean;
}): ReactNode {
  const { t } = useLingui();
  const label =
    status === 'completed'
      ? t`done`
      : status === 'failed'
        ? t`failed`
        : status === 'in_progress'
          ? t`running`
          : t`pending`;
  return (
    <span className="flex shrink-0 items-center">
      <span className="sr-only">{label}</span>
      {status === 'failed' ? (
        <Badge
          variant="destructive"
          className="rounded-sm px-1.5 py-0 text-[10px]"
          data-testid="agent-thread-tool-failed"
        >
          {label}
        </Badge>
      ) : status === 'in_progress' || status === 'pending' ? (
        // `pending` (accepted, not yet started) and `in_progress` both read as
        // "this call is in flight" — the distinction is the agent's bookkeeping,
        // not something worth two different marks on the row.
        <Loader2
          className="size-3.5 animate-spin text-muted-foreground"
          aria-hidden="true"
          data-testid="agent-thread-tool-spinner"
        />
      ) : completedLive ? (
        <Check
          className={cn(
            'size-3.5 text-muted-foreground/70 transition-opacity duration-500 motion-reduce:transition-none',
            checkVisible ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden="true"
          data-testid="agent-thread-tool-check"
        />
      ) : null}
    </span>
  );
}

/** A genuine line diff (jsdiff) with long unchanged runs collapsed — enough to
 *  read a tool-call diff without the full CodeMirror MergeView (reserved for
 *  the conflict/history surfaces). */
function InlineDiff({
  diff,
}: {
  diff: { path: string; oldText: string | null; newText: string };
}): ReactNode {
  const { t } = useLingui();
  const rows = computeDiffRows(diff.oldText, diff.newText);
  return (
    <div className="overflow-hidden rounded border border-border/60">
      <div className="bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
        {diff.path}
      </div>
      <pre className="overflow-x-auto font-mono text-[11px] leading-snug">
        {rows.map((row, index) =>
          row.type === 'gap' ? (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional
              key={index}
              className="select-none px-2 text-muted-foreground/70"
            >
              {t`⋯ ${row.count} unchanged lines`}
            </div>
          ) : (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional
              key={index}
              className={cn(
                'px-2',
                row.type === 'add' && 'bg-green-500/10 text-green-700 dark:text-green-400',
                row.type === 'del' && 'bg-red-500/10 text-red-700 dark:text-red-400',
                row.type === 'ctx' && 'text-muted-foreground',
              )}
            >
              <span aria-hidden="true">
                {row.type === 'add' ? '+ ' : row.type === 'del' ? '- ' : '  '}
              </span>
              {row.text}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}

/** One ACP terminal embedded in a tool call: the command OK ran for the
 *  agent, its (ANSI-stripped) output, and a live/exit status badge. */
function TerminalBlock({ terminal }: { terminal: RenderedTerminal }): ReactNode {
  const { t } = useLingui();
  const commandLine = [terminal.command, ...terminal.args].join(' ');
  const text = renderTerminalText(terminal.output);
  const exit = terminal.exit;
  const failed = exit !== null && (exit.signal !== null || exit.exitCode !== 0);
  return (
    <div
      className="overflow-hidden rounded border border-border/60"
      data-testid="agent-thread-terminal"
    >
      <div className="flex items-center gap-1.5 bg-muted/50 px-2 py-0.5">
        <TerminalIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={commandLine}>
          {commandLine}
        </span>
        <span className="ml-auto shrink-0">
          {exit === null ? (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground shimmer">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              {t`running`}
            </span>
          ) : (
            <Badge
              variant={failed ? 'destructive' : 'secondary'}
              className="px-1.5 py-0 font-mono text-[10px] rounded-sm"
              data-testid="agent-thread-terminal-exit"
            >
              {exit.signal !== null ? exit.signal : t`exit ${exit.exitCode ?? 0}`}
            </Badge>
          )}
        </span>
      </div>
      {text.trim() !== '' || terminal.truncated ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-2 py-1 font-mono text-[11px] leading-snug">
          {terminal.truncated ? `${t`… earlier output trimmed`}\n` : null}
          {text}
        </pre>
      ) : null}
    </div>
  );
}

/** The tool call's raw input — shown so the user can see what the tool was
 *  actually asked to do, not just the adapter's title for it. */
function RawInputBlock({ text }: { text: string }): ReactNode {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="agent-thread-tool-raw-input">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto w-full justify-start gap-1 px-0 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide hover:bg-transparent"
        onClick={() => setOpen((value) => !value)}
        // Disclosure per APG: `aria-expanded` alone — no `aria-controls`,
        // whose IDREF would dangle while the body is unmounted.
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3" aria-hidden="true" />
        )}
        {t`Input`}
      </Button>
      {open ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/30 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {text}
        </pre>
      ) : null}
    </div>
  );
}

function PermissionPrompt({
  item,
  threadId,
  actionable,
}: {
  item: Extract<RenderedItem, { kind: 'permission' }>;
  threadId: string;
  /** The thread is still live — a dead thread's prompt must not invite an answer. */
  actionable: boolean;
}): ReactNode {
  const { t } = useLingui();
  const outcomeLabel = usePermissionOutcomeLabel();
  const client = getAgentThreadClient();
  const outcome = resolvePermissionOutcome(item);
  const pending = outcome === null;
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  const selectOption = (optionId: string): void => {
    client.respondPermission(threadId, item.requestId, { kind: 'selected', optionId });
  };

  // Group by stance, never by looking up one option per kind: ACP `kind` is a
  // styling hint, not a key, and agents do offer several allows separated only
  // by `name` ("Allow for This Session" vs "Allow and Don't Ask Again").
  const allowOptions = item.options.filter((option) => option.kind.startsWith('allow'));
  const rejectOptions = item.options.filter((option) => option.kind.startsWith('reject'));
  // The least-privilege grant is the primary action; every escalating grant
  // keeps the agent's own ordering behind the secondary button beside it.
  const primaryAllow = allowOptions.find((o) => o.kind === 'allow_once') ?? allowOptions[0];
  const secondaryAllows = allowOptions.filter((option) => option !== primaryAllow);
  const primaryReject = rejectOptions.find((o) => o.kind === 'reject_once') ?? rejectOptions[0];
  const denyOptions =
    primaryReject === undefined
      ? []
      : [primaryReject, ...rejectOptions.filter((option) => option !== primaryReject)];
  // Focus lands on the primary grant; with no grant offered at all, the refusal
  // is the only actionable control left to take it.
  const focusRefForDeny = primaryAllow === undefined ? primaryRef : undefined;

  // Move focus onto the primary option when a live prompt appears — but only
  // if focus is already inside this thread's panel (e.g. on the composer the
  // user just typed in). A prompt landing while the user works in the editor
  // must not steal focus from it.
  useEffect(() => {
    if (!pending || !actionable) return;
    const root = cardRef.current?.closest('[data-agent-thread-root]');
    if (root == null || !root.contains(document.activeElement)) return;
    primaryRef.current?.focus();
  }, [pending, actionable]);

  const resolvedLabel = outcomeLabel(outcome);

  return (
    <div
      ref={cardRef}
      className={cn(
        // Neutral chrome throughout: a permission request is a routine choice,
        // and an alarm-colored card overstates it.
        'rounded-md border px-2.5 py-2 text-sm',
        pending && actionable ? 'border-border bg-muted/30' : 'border-border/60 bg-muted/20',
      )}
      data-testid="agent-thread-permission"
    >
      <div className="mb-1.5 font-medium">{item.title}</div>
      {!pending ? (
        <div
          className="text-muted-foreground text-xs"
          data-testid="agent-thread-permission-outcome"
        >
          {resolvedLabel}
        </div>
      ) : !actionable ? (
        // Unresolved on a dead turn (crash-mid-stream archive): answering is
        // impossible, so don't render buttons that would silently no-op.
        <div className="text-muted-foreground text-xs">{t`This request is no longer active.`}</div>
      ) : (
        // Refusal pinned far left, the primary grant far right, and every
        // escalating grant collapsed into the secondary button beside it — so
        // the row stays at most three controls however many options an agent
        // offers, and the two opposite answers never sit next to each other.
        <div className="flex flex-wrap items-center justify-between gap-2">
          {denyOptions.length > 0 ? (
            <PermissionOptionCluster
              options={denyOptions}
              onSelect={selectOption}
              buttonRef={focusRefForDeny}
              testId="agent-thread-permission-deny"
              moreLabel={t`More refusal options`}
              menuAlign="start"
            />
          ) : (
            // ACP has no first-class per-tool deny beyond the agent's own
            // reject options; `cancelled` is the protocol's only refusal
            // channel, and agents may treat it as cancelling the whole turn.
            // Shown only when the agent offered none, so "no" exists at all.
            <Button
              ref={focusRefForDeny}
              type="button"
              size="sm"
              variant="outline"
              className="text-xs"
              onClick={() =>
                client.respondPermission(threadId, item.requestId, { kind: 'cancelled' })
              }
              data-testid="agent-thread-permission-deny"
            >
              {t`Deny`}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {secondaryAllows.length > 0 ? (
              <PermissionOptionCluster
                options={secondaryAllows}
                onSelect={selectOption}
                testId="agent-thread-permission-allow-more"
                moreLabel={t`More grant options`}
                menuAlign="end"
              />
            ) : null}
            {primaryAllow !== undefined ? (
              <Button
                ref={primaryRef}
                type="button"
                size="sm"
                // The `default` Button variant is `font-mono uppercase`, which
                // is right for fixed UI verbs and wrong for a label the agent
                // wrote — "Allow for This Session" must not render shouted.
                className="text-xs normal-case font-sans"
                title={primaryAllow.name}
                onClick={() => selectOption(primaryAllow.optionId)}
                data-testid="agent-thread-permission-allow"
                data-permission-kind={primaryAllow.kind}
              >
                <span className="max-w-52 truncate">{primaryAllow.name}</span>
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One cluster of permission choices that share a stance. `options[0]` is the
 * directly-actionable button — a single click answers with it, so the common
 * two-option case never costs an extra trip through a menu — and any further
 * options collapse behind its chevron. The menu repeats the primary so it
 * reads as the complete list of choices at that stance.
 *
 * Agent-authored names run long ("Always allow all mcp__open-knowledge__exec"),
 * so the button label is width-capped with the full string on its tooltip;
 * the menu, which has room, always shows names in full.
 */
function PermissionOptionCluster({
  options,
  onSelect,
  buttonRef,
  testId,
  moreLabel,
  menuAlign,
}: {
  options: Extract<RenderedItem, { kind: 'permission' }>['options'];
  onSelect: (optionId: string) => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  testId: string;
  moreLabel: string;
  menuAlign: 'start' | 'end';
}): ReactNode {
  const primary = options[0];
  if (primary === undefined) return null;

  const primaryButton = (
    <Button
      ref={buttonRef}
      type="button"
      size="sm"
      variant="outline"
      className="text-xs"
      title={primary.name}
      onClick={() => onSelect(primary.optionId)}
      data-testid={testId}
      data-permission-kind={primary.kind}
    >
      <span className="max-w-52 truncate">{primary.name}</span>
    </Button>
  );

  if (options.length === 1) return primaryButton;

  return (
    <ButtonGroup>
      {primaryButton}
      <ButtonGroupSeparator />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label={moreLabel}
            data-testid={`${testId}-more`}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={menuAlign} className="max-w-72">
          {options.map((option) => (
            <DropdownMenuItem
              key={option.optionId}
              onSelect={() => onSelect(option.optionId)}
              data-permission-kind={option.kind}
            >
              {option.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

/**
 * Prompt (and progress) for OK downloading a language runtime an agent needs
 * but the machine lacks (npx→Node.js, uvx→uv). Modeled on {@link
 * PermissionPrompt}: the card is a retained transcript item, so it renders the
 * same on live launch and on replay of an archived thread.
 */
function RuntimeConsentPrompt({
  item,
  threadId,
}: {
  item: Extract<RenderedItem, { kind: 'runtime_consent' }>;
  threadId: string;
}): ReactNode {
  const { t } = useLingui();
  const client = getAgentThreadClient();
  const [remember, setRemember] = useState(true);

  if (item.resolved === 'declined' || item.resolved === 'timeout') {
    return (
      <div
        className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-muted-foreground text-xs"
        data-testid="agent-thread-runtime-consent"
      >
        {item.resolved === 'declined'
          ? t`Skipped downloading ${item.displayName}.`
          : t`The ${item.displayName} download request timed out.`}
      </div>
    );
  }

  if (item.resolved === 'granted') {
    if (item.install === 'done') {
      return (
        <div
          className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-muted-foreground text-xs"
          data-testid="agent-thread-runtime-consent"
        >
          <Check
            className="size-3.5 shrink-0 text-green-600 dark:text-green-400"
            aria-hidden="true"
          />
          <span>{t`Installed ${item.displayName} ${item.version}`}</span>
        </div>
      );
    }
    if (item.install === 'failed') {
      return (
        <div
          className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-muted-foreground text-xs"
          data-testid="agent-thread-runtime-consent"
        >
          {t`Couldn't finish installing ${item.displayName} — see below.`}
        </div>
      );
    }
    const pct = consentPercent(item.progress);
    return (
      <div
        className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-xs"
        data-testid="agent-thread-runtime-consent"
      >
        <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span>{t`Downloading ${item.displayName} ${item.version}…`}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: pct !== null ? `${pct}%` : '40%' }}
          />
        </div>
        {pct !== null ? (
          <div className="mt-1 text-[11px] text-muted-foreground">{`${pct}%`}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="rounded-md border border-blue-500/40 bg-blue-500/5 px-2.5 py-2 text-sm"
      data-testid="agent-thread-runtime-consent"
    >
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <Download className="size-4 shrink-0" aria-hidden="true" />
        <span>{t`${item.agentName} needs ${item.displayName}`}</span>
      </div>
      <p className="mb-2 text-muted-foreground text-xs">
        {t`This agent runs through ${item.provides}, which isn't installed. Open Knowledge can download a private copy of ${item.displayName} ${item.version} (about ${item.approxSizeMB} MB from ${item.sourceHost}) that won't touch the rest of your system.`}
      </p>
      <label
        htmlFor={`runtime-consent-remember-${item.requestId}`}
        className="mb-2 flex w-fit items-center gap-1.5 text-muted-foreground text-xs"
      >
        <Checkbox
          id={`runtime-consent-remember-${item.requestId}`}
          checked={remember}
          onCheckedChange={(value) => setRemember(value === true)}
          data-testid="agent-thread-runtime-consent-remember"
        />
        {t`Remember this for future agents`}
      </label>
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          onClick={() =>
            client.respondRuntimeConsent(threadId, item.requestId, { kind: 'granted', remember })
          }
          data-testid="agent-thread-runtime-consent-allow"
        >
          {t`Download ${item.displayName}`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() =>
            client.respondRuntimeConsent(threadId, item.requestId, { kind: 'declined', remember })
          }
          data-testid="agent-thread-runtime-consent-decline"
        >
          {t`Not now`}
        </Button>
      </div>
    </div>
  );
}

function consentPercent(
  progress: { receivedBytes: number; totalBytes: number | null } | null,
): number | null {
  if (progress === null || progress.totalBytes === null || progress.totalBytes <= 0) return null;
  return Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100));
}

/** Compact token count for the usage tooltip: `108k`, `1.5M`, `950`. */
function formatCompactTokens(value: number): string {
  const thousands = Math.round(value / 1_000);
  // Promote to M once the rounded k would read as 1000k (e.g. 999,600 → 1M).
  if (thousands >= 1_000) {
    const millions = value / 1_000_000;
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${thousands}k`;
  return String(value);
}

/**
 * Context-window fill as a mini progress ring — the whole point is "how full",
 * which a ring conveys at a glance where the token counts read as noise. The
 * exact numbers move to a tooltip. Tone escalates as the window fills (amber
 * ≥75%, red ≥90%) so "almost out of room" reads without opening the tooltip.
 * The trigger is a real focusable button so keyboard + screen-reader users get
 * the same figures hover users do (`label` is its accessible name).
 */
function ContextUsageRing({
  used,
  size,
  percent,
}: {
  used: number;
  size: number;
  percent: number;
}): ReactNode {
  const { t } = useLingui();
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const tone =
    percent >= 90 ? 'text-red-500' : percent >= 75 ? 'text-amber-500' : 'text-muted-foreground/60';
  const left = 100 - percent;
  const usedLabel = formatCompactTokens(used);
  const sizeLabel = formatCompactTokens(size);
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={t`Context window: ${percent}% used, ${usedLabel} of ${sizeLabel} tokens`}
        className="flex size-5 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        data-testid="agent-thread-usage"
      >
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            strokeWidth="2"
            className="stroke-current text-muted-foreground/10"
          />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - percent / 100)}
            className={cn('stroke-current transition-[stroke-dashoffset]', tone)}
          />
        </svg>
      </TooltipTrigger>
      <TooltipContent side="top">
        {/* Wrap the lines: the base TooltipContent is inline-flex (a row), so
            sibling spans would render side by side without a column wrapper. */}
        <div className="flex flex-col items-center gap-0.5 text-center">
          <span className="text-background/60">{t`Context window:`}</span>
          <span>{t`${percent}% used (${left}% left)`}</span>
          <span className="tabular-nums">{t`${usedLabel} / ${sizeLabel} tokens used`}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function ThreadComposer({
  info,
  draft,
  onDraftChange,
  onSubmit,
  canPrompt,
  canQueue,
  turnActive,
  cancelPending,
  onCancel,
  onSteer,
  status,
  archived,
  resumePending,
  usage,
  queuedComments,
  selectedCommentCount,
  hasQueuedComments,
  commentsExpanded,
  onAttachComments,
  onToggleCommentsExpanded,
  onDismissComments,
}: {
  info: ThreadInfo;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  canPrompt: boolean;
  /** A turn is running — sends queue behind it instead of dispatching. */
  canQueue: boolean;
  turnActive: boolean;
  /** Stop was pressed and the turn hasn't ended yet. */
  cancelPending: boolean;
  onCancel: () => void;
  /** Stop the running turn and send the draft as the next one. */
  onSteer: () => void;
  status: ThreadInfo['status'];
  archived: boolean;
  /** A resume op is in flight (archived thread, message queued on it). */
  resumePending: boolean;
  /** Context-window fill the agent reported; null until it reports any. */
  usage: { used?: number; size?: number } | null;
  /** The review comments waiting to be sent, in queue order. */
  queuedComments: readonly CommentThread[];
  /** How many of them are checked — what an attached send would carry. */
  selectedCommentCount: number;
  /**
   * The batch is riding this message AND still has something checked — the
   * derived flag, never the raw attached state. `BottomComposer` carries the
   * same distinction: unchecking the last item means nothing rides this
   * message, which is the detached state however it was reached, and keying the
   * chip on the raw flag leaves a countless chip above a list of unchecked rows.
   */
  hasQueuedComments: boolean;
  commentsExpanded: boolean;
  onAttachComments: () => void;
  onToggleCommentsExpanded: () => void;
  onDismissComments: () => void;
}): ReactNode {
  const { t } = useLingui();
  const ref = useRef<HTMLTextAreaElement>(null);
  // Naming the agent in the placeholder ("Message Claude") beats a generic
  // "Message the agent"; strip the "Agent" suffix so it reads as the brand.
  const agentName = agentDisplayName(info.agent.name);

  // Grow with content up to a cap. `draft` is the trigger, not read in the
  // body (the element's own scrollHeight is), so the analyzer sees it as
  // redundant — but it is exactly what should re-run the resize.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft is the resize trigger, not a body dependency
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const usagePercent =
    usage !== null && usage.used !== undefined && usage.size !== undefined && usage.size > 0
      ? Math.min(100, Math.round((usage.used / usage.size) * 100))
      : null;

  const queue = info.queue ?? [];

  const queueSize = queuedComments.length;

  // What the action slot keys off. Both the Stop/Send choice and Send's disabled
  // state read this, or the two disagree. An attached batch counts as content:
  // the comments are the ask, so a send with nothing typed is a real send.
  const hasSendableContent = draft.trim() !== '' || hasQueuedComments;

  // Mid-turn the same control queues rather than sends, so it stops wearing the
  // send arrow — an aria-label the sighted user never reads was the only thing
  // distinguishing the two outcomes.
  const sendButton = (
    <Button
      type="button"
      size="icon-sm"
      className="rounded-lg"
      disabled={!(canPrompt || canQueue) || !hasSendableContent}
      onClick={onSubmit}
      aria-label={canQueue ? t`Queue message` : t`Send`}
      data-testid="agent-thread-send"
    >
      {canQueue ? (
        <ListPlus className="size-4" aria-hidden="true" />
      ) : (
        <ArrowUp className="size-4" aria-hidden="true" />
      )}
    </Button>
  );

  return (
    <div className="p-2">
      {queue.length > 0 && !archived ? (
        <QueuedMessageList threadId={info.threadId} queue={queue} />
      ) : null}
      {/* Two-row field: the textarea fills the full width on top; a bottom bar
          holds the model/agent settings (left) and the context ring + send/stop
          (right). The wrapper owns the border + focus ring so the whole box lights
          up on focus. Every control is a real in-flow sibling (natural Tab order,
          own focus ring) and the send button lives on its own row, so there's no
          reserved text gutter narrowing the input on multi-line drafts. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only affordance — pressing the card's whitespace focuses the textarea; keyboard/AT users reach it via Tab. See focus-composer-on-card-pointer.ts. */}
      <div
        onMouseDown={(event) => focusComposerInputOnCardPointer(event, ref)}
        className="cursor-text rounded-lg border border-input bg-transparent transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30"
      >
        {/* Queued comments as a context chip above the field, the same control
            the Ask AI composer carries — detached it is a `+ Comments` add
            button, attached it grows the peek + ✕ the other context chips have.
            Same row component, so the two composers read as one chip system. */}
        {/* Gated here as well as inside the chip: `ComposerContextChips` decides
            whether to render its row by counting children, and an element that
            returns null still counts as one. An empty queue has to contribute NO
            child, or the row appears as an empty strip above the field. */}
        {queueSize > 0 ? (
          <ComposerContextChips className="px-3 pt-2 pb-1">
            <QueuedCommentsChip
              // Attached, the count is what a SEND carries, so unchecking an
              // item moves it. Detached the chip shows no number, so the raw
              // queue is what decides it renders at all.
              count={hasQueuedComments ? selectedCommentCount : queueSize}
              attached={hasQueuedComments}
              expanded={commentsExpanded}
              onAttach={onAttachComments}
              onToggleExpanded={onToggleCommentsExpanded}
              onDismiss={onDismissComments}
            />
            {hasQueuedComments && commentsExpanded ? (
              <QueuedCommentsList threads={queuedComments} />
            ) : null}
          </ComposerContextChips>
        ) : null}
        <Textarea
          ref={ref}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            } else if (event.key === 'Escape' && turnActive && !cancelPending) {
              // Deliberately field-scoped, not panel-wide. Sendable content hides
              // Stop, so Escape is the cancel path while composing — but Escape
              // is a dismiss-shaped key, and binding it panel-wide would let a
              // stray press kill a running turn with no undo. The accepted cost:
              // leave content in the composer, click away, and neither Stop nor
              // Escape is reachable until you click back or clear it. Judged rare
              // enough to accept over a broader binding or a second Stop.
              event.preventDefault();
              onCancel();
            }
          }}
          rows={1}
          // Stable accessible name — the placeholder is situational (and a
          // placeholder alone isn't a reliable label for screen readers).
          aria-label={t`Message ${agentName}`}
          placeholder={
            archived
              ? resumePending
                ? t`Resuming the chat`
                : t`Pick up where you left off`
              : status === 'auth_required'
                ? t`Sign in to ${agentName} first`
                : t`Message ${agentName}`
          }
          disabled={
            archived
              ? resumePending
              : // Typable in every live state, including the ones that are only
                // waiting on something: signing in takes a detour through a
                // browser (and flips the status to `installing` while it does),
                // a failed start is a Retry away from running, and a draft
                // written across any of that must survive. Only a thread whose
                // agent is gone for good has nothing left to say. Sending is
                // still gated by canPrompt / canQueue.
                status === 'exited'
          }
          // Borderless + transparent so the wrapper alone renders the field chrome
          // and focus ring (no doubled border/ring). Full width — the action bar
          // sits on its own row below, so no right-padding gutter is reserved.
          className="max-h-40 min-h-9 resize-none border-0 bg-transparent pb-0 shadow-none focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent placeholder:text-muted-foreground/60"
          data-testid="agent-thread-composer"
        />
        {/* Action bar: model/agent settings on the left, context ring + send/stop
            on the right. The send cluster uses `ml-auto` (not the row's
            justify-between) so it stays hard-right even when the settings popover
            renders nothing — while the agent is loading / errored / auth-required
            it exposes no config options, and justify-between would then float the
            lone send button to the left. */}
        <div className="flex items-center gap-2 px-1.5 pt-1 pb-1.5">
          <AgentSettingsPopover info={info} />
          <div className="ml-auto flex items-center gap-1.5">
            {usagePercent !== null && usage?.used !== undefined && usage?.size !== undefined ? (
              <ContextUsageRing used={usage.used} size={usage.size} percent={usagePercent} />
            ) : null}
            {/* One action slot, never two competing buttons. Mid-turn it holds
                Stop until there is something to send, then yields so it can
                queue — the convention every agent chat with a queue follows.
                `cancelPending` outranks the content check: a cancel can hang for
                CANCEL_STALL_MS, and typing during that window must not replace
                the only signal that the stop was heard. */}
            {turnActive && (cancelPending || !hasSendableContent) ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    className="rounded-lg"
                    disabled={cancelPending}
                    onClick={onCancel}
                    aria-label={cancelPending ? t`Stopping` : t`Stop`}
                    data-testid="agent-thread-cancel"
                  >
                    {cancelPending ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Square className="size-3 fill-current" aria-hidden="true" />
                    )}
                  </Button>
                </TooltipTrigger>
                {/* Teaches the Escape binding while Stop is visible, so it's
                    already known in the draft-present state where it's hidden. */}
                <TooltipContent side="top">{t`Stop (Esc)`}</TooltipContent>
              </Tooltip>
            ) : canQueue ? (
              <>
                {/* Steering sends the typed words, so it appears only when there
                    are some — an attached comment batch has its own delivery
                    rules (it stays queued until a turn actually runs it) and
                    must not be interrupted onto a run being cancelled. */}
                {draft.trim() !== '' ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        className="rounded-lg"
                        onClick={onSteer}
                        aria-label={t`Steer now`}
                        data-testid="agent-thread-steer"
                      >
                        <Zap className="size-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{t`Stops the current run and sends this instead`}</TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>{sendButton}</TooltipTrigger>
                  {/* The icon change alone says "not a plain send"; this says what
                      actually happens to the message. */}
                  <TooltipContent side="top">{t`Queues behind the running turn`}</TooltipContent>
                </Tooltip>
              </>
            ) : (
              sendButton
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Messages waiting behind the active turn, shown between the transcript and
 *  the composer. Server-authoritative (`ThreadInfo.queue`): rows appear for
 *  every subscriber of the thread and vanish as each entry dispatches. */
function QueuedMessageList({
  threadId,
  queue,
}: {
  threadId: string;
  queue: readonly QueuedMessage[];
}): ReactNode {
  const { t } = useLingui();
  return (
    <div className="mb-1.5 flex flex-col gap-1" data-testid="agent-thread-queue">
      <span className="px-1 font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wide">
        {t`Queued — sends when this run finishes`}
      </span>
      {queue.map((message) => (
        <QueuedMessageRow key={message.id} threadId={threadId} message={message} />
      ))}
    </div>
  );
}

function QueuedMessageRow({
  threadId,
  message,
}: {
  threadId: string;
  message: QueuedMessage;
}): ReactNode {
  const { t } = useLingui();
  const client = getAgentThreadClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  const held = message.held === true;

  const release = (): void => client.holdQueued(threadId, message.id, false);

  const startEdit = (): void => {
    // Hold before the editor opens: a turn ending mid-edit would otherwise
    // dispatch the very text being replaced, and the edit would die with the
    // row. Every exit from editing releases the hold or saves over it.
    client.holdQueued(threadId, message.id, true);
    setValue(message.content);
    setEditing(true);
  };
  const cancelEdit = (): void => {
    setEditing(false);
    release();
  };
  const save = (): void => {
    const trimmed = value.trim();
    if (trimmed === '') {
      // Empty isn't a valid queued prompt. Treat Enter-on-empty as cancel —
      // exit editing and keep the original — rather than trapping the user in
      // edit mode with a silent no-op. Removing is its own explicit action.
      cancelEdit();
      return;
    }
    setEditing(false);
    if (trimmed === message.content) {
      release();
      return;
    }
    // Saving is the resubmit — the server clears the hold with the content.
    void client.editQueued(threadId, message.id, trimmed).catch(() => {
      toast.error(t`That message already went out — your edit wasn't applied.`);
    });
  };

  if (editing) {
    return (
      <div
        className="rounded-md border border-input bg-muted/30 p-1"
        data-testid="agent-thread-queued-editing"
      >
        <Textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              save();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelEdit();
            }
          }}
          autoFocus
          rows={1}
          aria-label={t`Edit queued message`}
          className="min-h-8 resize-none border-0 bg-transparent px-1.5 py-1 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          data-testid="agent-thread-queued-input"
        />
        <div className="flex items-center justify-end gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="size-6"
            onClick={cancelEdit}
            aria-label={t`Cancel editing`}
            data-testid="agent-thread-queued-cancel-edit"
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="size-6"
            disabled={value.trim() === ''}
            onClick={save}
            aria-label={t`Save queued message`}
            data-testid="agent-thread-queued-save"
          >
            <Check className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-md border py-0.5 pl-2 pr-1',
        held ? 'border-input/40 border-dashed bg-muted/20' : 'border-input/60 bg-muted/30',
      )}
      data-testid="agent-thread-queued"
      data-held={held ? 'true' : undefined}
    >
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-sm',
          held ? 'text-muted-foreground/60' : 'text-muted-foreground',
        )}
      >
        {message.content}
      </span>
      {held ? (
        <>
          {/* A row the drain skips has to say so, or it reads as queued and the
              user waits for a message that is never going anywhere. */}
          <span className="shrink-0 font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wide">
            {t`Held`}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="size-6 shrink-0 text-muted-foreground"
            onClick={release}
            aria-label={t`Send when the agent is free`}
            data-testid="agent-thread-queued-release"
          >
            <Check className="size-3.5" aria-hidden="true" />
          </Button>
        </>
      ) : null}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="size-6 shrink-0 text-muted-foreground"
        onClick={startEdit}
        aria-label={t`Edit queued message`}
        data-testid="agent-thread-queued-edit"
      >
        <SquarePen className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="size-6 shrink-0 text-muted-foreground"
        onClick={() => client.removeQueued(threadId, message.id)}
        aria-label={t`Remove queued message`}
        data-testid="agent-thread-queued-remove"
      >
        <X className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
