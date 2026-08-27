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

import { deriveAgentPosture } from '@inkeep/open-knowledge-core/acp/agent-posture';
import type {
  AttachmentPart,
  QueuedMessage,
  SessionConfigOption,
  ThreadFailureDetail,
  ThreadInfo,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { plural } from '@lingui/core/macro';
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
  MousePointer2,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Share2,
  ShieldAlert,
  Shuffle,
  Sparkles,
  Square,
  SquarePen,
  Terminal as TerminalIcon,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import {
  createContext,
  Fragment,
  type ReactNode,
  type RefObject,
  use,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import {
  type CommentDocTally,
  composeCommentBatchInstruction,
  QueuedCommentsChip,
  toCommentBatchItem,
  useSelectedCommentCount,
  useSelectedCommentDocs,
} from '@/comments/comment-chips';
import { subscribeSendInThread } from '@/comments/open-chat-send';
import { dispatchComments, subscribeCommentPosted } from '@/comments/store';
import { ComposerContextChips } from '@/components/ComposerContextChips';
import { focusComposerInputOnCardPointer } from '@/components/focus-composer-on-card-pointer';
import { useOptionalPageList } from '@/components/PageListContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
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
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorkingAvatar } from '@/components/WorkingAvatar';
import {
  ComposerMentionInput,
  type ComposerMentionInputHandle,
} from '@/editor/ComposerMentionInput';
import { useDocumentContext } from '@/editor/DocumentContext';
import {
  agentSettingsKey,
  rememberAgentConfigOption,
  rememberAgentMode,
} from '@/lib/acp/agent-settings-store';
import { configValueHint, resolveDefaultOptionLabel } from '@/lib/acp/config-value-hints';
import {
  collectAllFiles,
  collectImageFiles,
  describeImageError,
  fileToAttachment,
} from '@/lib/acp/image-attachment';
import { computeDiffRows } from '@/lib/acp/inline-diff';
import { launchAgentThread } from '@/lib/acp/launch-agent-thread';
import { isPermissiveMode } from '@/lib/acp/permissive-mode';
import { parseSignInOutput, shortenUrl } from '@/lib/acp/sign-in-output';
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
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { useWorkspace } from '@/lib/use-workspace';
import { cn } from '@/lib/utils';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentNoticeAnnouncer } from './AgentNoticeAnnouncer';
import { buildDocPathResolver, setDocPathResolver } from './doc-path-links';
import { DocPathResolverReadyContext } from './doc-path-links-context';
import {
  decideFollowNavigation,
  type FollowNavState,
  INITIAL_FOLLOW_NAV_STATE,
  latestFollowTarget,
  loadFollowFilePref,
  saveFollowFilePref,
} from './follow-file';
import { PlanChecklist } from './PlanChecklist';
import { appendPresenceWrite, latestAgentWrite, type PresenceWrite } from './presence-follow';
import { RegisteredAgentIcon } from './RegisteredAgentIcon';
import { transcriptItemId } from './transcript-item-id';
import { type ResendTarget, UserMessageActions, UserMessageEditor } from './UserMessageActions';
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

/** Payload for the shared image-preview lightbox. `src` is a data URL for
 *  base64 payloads (image AttachmentParts on both sent + unsent tiles). */
type ImagePreview = { readonly src: string; readonly name: string };

/** Panel-scoped context for the shared image-preview dialog. `null` when a
 *  descendant renders outside the ThreadView provider (test harness, etc.);
 *  tile components render as non-interactive in that case. */
const ImagePreviewContext = createContext<((preview: ImagePreview) => void) | null>(null);

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

/**
 * The one line in an ACP failure's stderr tail that names WHY it failed —
 * pulled out and rendered above the "Show details" toggle so a reader gets
 * the diagnostic without expanding a wall of unrelated warnings. Matches
 * common failure signals from the tools ACP agents spawn (npm/npx, uv/uvx,
 * shell, node). Returns null when nothing looks like an error signal — the
 * card then falls back to the plain "Show details" toggle it always had.
 *
 * FIRST match wins. npm prints the terminating cause up-front (`npm error
 * code EUSAGE`) and follows with a metadata + summary block that ends in
 * `npm error A complete log of this run can be found in: …` — a last-match
 * heuristic surfaces the log-path epilogue instead of the cause, which is
 * exactly what this feature exists to skip past. `\s+\S` after the prefix
 * skips bare `npm error` separator lines (npm block output uses them as
 * blank rules between metadata groups).
 */
const ROOT_CAUSE_PATTERN =
  /^\s*(?:npm\s+(?:error|ERR!)\s+\S|error:\s*\S|Error:\s*\S|fatal:\s*\S|panic:\s*\S)/;
function extractRootCauseLine(machineDetail: string): string | null {
  const lines = machineDetail.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? '';
    if (line !== '' && ROOT_CAUSE_PATTERN.test(line)) return line;
  }
  return null;
}

/**
 * Colorize the stderr detail so `error` / `warn` lines are visible at a
 * glance instead of drowning in a wall of same-color monospace. Same
 * classifier as `extractRootCauseLine`, plus an `npm warn` / `warning:`
 * amber tier. Neutral lines keep the container's muted colour.
 */
const STDERR_ERROR_PATTERN = /^\s*(?:npm\s+(?:error|ERR!)|error:|Error:|fatal:|panic:)/;
const STDERR_WARN_PATTERN = /^\s*(?:npm\s+warn|warning:|warn:)/;
function highlightStderr(machineDetail: string): ReactNode {
  const lines = machineDetail.split('\n');
  return lines.map((line, i) => {
    const key = `${i}:${line.slice(0, 32)}`;
    const cls = STDERR_ERROR_PATTERN.test(line)
      ? 'text-red-600 dark:text-red-400'
      : STDERR_WARN_PATTERN.test(line)
        ? 'text-amber-700 dark:text-amber-400'
        : '';
    return (
      <span key={key} className={cls}>
        {line}
        {i < lines.length - 1 ? '\n' : ''}
      </span>
    );
  });
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
  // The composer input (the shared rich `@`-mention field) owns the draft; this
  // component reads it at each send via the imperative handle and seeds it via
  // `appendText` — there is no draft string in React state anymore.
  const composerRef = useRef<ComposerMentionInputHandle>(null);
  // Image parts (dropped/pasted) live on the ThreadView side rather than
  // inside the shared composer so they survive a placement swap without a
  // schema change. Cleared on send/clear alongside the composer text.
  // Files/images the user dropped or picked. Union of image + generic blob
  // parts — the composer's own @-picker chips ride the wire separately via
  // `serializeComposerContent().attachments`, so this list is the OS-file
  // half. Cleared on send/clear alongside the composer text.
  const [pendingAttachments, setPendingAttachments] = useState<readonly AttachmentPart[]>([]);
  // Full-size image preview modal shared by the pending strip (unsent) and
  // the transcript chips (sent). Kept at ThreadView scope so a sent chip
  // dismisses cleanly even if the composer re-renders — one dialog per panel.
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const openImagePreview = (preview: ImagePreview) => setImagePreview(preview);
  const [pendingUploads, setPendingUploads] = useState<
    readonly { readonly id: string; readonly name: string; readonly mimeType: string }[]
  >([]);
  // Visual state for the drop overlay on the outer chat panel: rises as
  // soon as any dragenter carrying files hits it, drops on drop / dragleave
  // from the root.
  const [dragActive, setDragActive] = useState(false);
  const [dropNotice, setDropNotice] = useState<{ text: string; id: number } | null>(null);
  const dropNoticeIdRef = useRef(0);
  useEffect(() => {
    if (dropNotice === null) return;
    const timer = setTimeout(() => setDropNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [dropNotice]);
  // Pessimistic match to the server's gate: an agent that advertised no
  // capabilities at all (`promptCapabilities` undefined) doesn't accept
  // images. Being optimistic here (accept unless `false`) drops the image
  // silently server-side with only a log entry — the user sees the send
  // succeed and no image reaches the agent. The narrow window between
  // connect and first `info` event where a real image-capable agent reads
  // as unknown is the accepted cost of matching server behavior.
  const imagesAccepted = info.promptCapabilities?.image === true;
  // The current serialized draft: typed prose with chips inline as `@path`.
  // Called from event handlers only (a render must not read the ref).
  const composerText = (): string => composerRef.current?.getContent().instruction.trim() ?? '';
  // The union of file/folder chips (from the composer's own serializer) and
  // the host-owned image attachments. Deferred to send time so a change to
  // either half doesn't re-render the composer.
  const composerAttachments = (): readonly AttachmentPart[] => {
    const chips = composerRef.current?.getContent().attachments ?? [];
    return [...chips, ...pendingAttachments];
  };
  /**
   * Validate + encode a batch of dropped, pasted, or picked files, then
   * extend `pendingAttachments`. Actionable failures (`too-large`,
   * `unsupported-type`, a broken read) raise a per-file toast so the user
   * can retry each specific case. Non-actionable skips (`outside-workspace`,
   * `unknown-path`) collapse into a single muted inline notice above the
   * composer with the aggregate count — the user cannot make the file
   * attach from outside the workspace, so N red toasts saying the same
   * thing is noise. Images become `image` parts (fast-path via
   * ImageContent); non-image files become `file` parts pointing at a
   * workspace-relative path — the server resolves those to
   * `EmbeddedResource` (text under the embed cap) or `ResourceLink`
   * (binaries + oversized).
   */
  const ingestFiles = async (files: readonly File[]): Promise<void> => {
    // Electron exposes `webUtils.getPathForFile` — the only reliable way to
    // recover the on-disk path of a dropped File (browsers hide it for
    // security). Web hosts land at `undefined`, and non-image files are
    // refused there because the workspace-containment check can't run.
    const absPathOf =
      typeof window !== 'undefined' && window.okDesktop
        ? window.okDesktop.getPathForFile
        : undefined;
    const workspaceContentDir = workspace?.contentDir;
    const pathSeparator = workspace?.pathSeparator;
    // Refuse image files up front for an agent that didn't advertise image
    // capability — otherwise they'd thumbnail in the composer and be dropped
    // silently server-side (see `imagesAccepted` derivation above). Both drop
    // and picker paths flow through here, so the refusal covers both.
    const accepted: File[] = [];
    let rejectedImageCount = 0;
    for (const file of files) {
      const isImage = (file.type || '').startsWith('image/');
      if (isImage && !imagesAccepted) {
        rejectedImageCount += 1;
      } else {
        accepted.push(file);
      }
    }
    if (rejectedImageCount > 0) {
      // Bind as `agentName` so this msgid is byte-identical to the paste
      // handler below — Lingui keys by substitution name.
      const agentName = agentDisplayName(info.agent.name);
      toast.error(t`${agentName} doesn't accept image attachments.`);
    }
    if (accepted.length === 0) return;
    const placeholders = accepted.map((file) => ({
      id: `${file.name}:${file.size}:${file.lastModified ?? 0}:${Math.random().toString(36).slice(2, 8)}`,
      name: file.name || 'attachment',
      mimeType: file.type || '',
    }));
    setPendingUploads((previous) => [...previous, ...placeholders]);
    let outsideWorkspaceCount = 0;
    let unknownPathCount = 0;
    for (let i = 0; i < accepted.length; i += 1) {
      const file = accepted[i];
      const placeholderId = placeholders[i]?.id;
      if (file === undefined || placeholderId === undefined) continue;
      // Try/catch here (not just inside fileToAttachment) so a rejected
      // FileReader — corrupted file, OS I/O failure mid-drag, browser
      // memory pressure — clears its placeholder instead of leaving a
      // permanent spinner (and doesn't abort the remaining files either).
      try {
        const outcome = await fileToAttachment(file, {
          absPathOf,
          workspaceContentDir,
          pathSeparator,
        });
        setPendingUploads((previous) => previous.filter((p) => p.id !== placeholderId));
        if (outcome.ok) {
          setPendingAttachments((previous) => [...previous, outcome.part]);
        } else if (outcome.error.kind === 'outside-workspace') {
          outsideWorkspaceCount += 1;
        } else if (outcome.error.kind === 'unknown-path') {
          unknownPathCount += 1;
        } else {
          toast.error(describeImageError(outcome.error));
        }
      } catch (err) {
        setPendingUploads((previous) => previous.filter((p) => p.id !== placeholderId));
        const fileName = file.name || 'attachment';
        // Log before toasting so post-incident diagnosis has something to
        // grep — the toast only tells the user "something failed", not what.
        console.error('[ingestFiles] failed to read attachment', fileName, err);
        toast.error(t`Couldn't read ${fileName}.`);
      }
    }
    const skipTotal = outsideWorkspaceCount + unknownPathCount;
    if (skipTotal > 0) {
      let noticeText: string;
      if (unknownPathCount === 0) {
        noticeText = t`${plural(outsideWorkspaceCount, {
          one: 'Skipped # file outside the workspace.',
          other: 'Skipped # files outside the workspace.',
        })}`;
      } else if (outsideWorkspaceCount === 0) {
        noticeText = t`${plural(unknownPathCount, {
          one: "Skipped # file — this browser can't attach files by path.",
          other: "Skipped # files — this browser can't attach files by path.",
        })}`;
      } else {
        noticeText = t`${plural(skipTotal, {
          one: "Skipped # file that couldn't be attached.",
          other: "Skipped # files that couldn't be attached.",
        })}`;
      }
      dropNoticeIdRef.current += 1;
      setDropNotice({ text: noticeText, id: dropNoticeIdRef.current });
    }
  };
  const removePendingAttachment = (index: number): void => {
    setPendingAttachments((previous) => previous.filter((_, i) => i !== index));
  };
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
  // arriving after the user started typing can't eat their words. The handle is
  // populated before this subscribes: the composer child's ref commits before
  // the parent's effects run, so a value staged before mount is not dropped.
  useEffect(() => {
    return subscribeStagedThreadDraft(info.threadId, (text) => {
      composerRef.current?.appendText(text);
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
  // Prompt failures don't kill the session — the child is alive and the
  // server accepts another `session/prompt` — so the composer stays usable
  // after one. Without this, Edit-and-resend seeds text into a Send button
  // still disabled because `status === 'error'` from the failed turn.
  const hasRecoverablePromptFailure =
    !archived &&
    status === 'error' &&
    (model?.items ?? []).some(
      (item) =>
        item.kind === 'notice' && item.superseded !== true && item.failure?.reason === 'prompt',
    );
  const canPrompt = archived
    ? !resumePending
    : (status === 'ready' || hasRecoverablePromptFailure) && !turnActive;
  // A live thread sitting in a failure status never opened a session, so the
  // launch can simply be run again — see the server's `retryThread` guards.
  // The sign-in prompt owns both halves of the wait: the offer, and the round
  // trip the user is off completing. Dropping it the moment `authenticate` is
  // called is what made a click look like it had done nothing.
  const signingIn = status === 'authenticating';
  const awaitingSignIn = status === 'auth_required' || signingIn;
  // A sign-in abandoned in a browser tab holds the thread until it times out —
  // the server treats an in-flight one as retryable for exactly that reason.
  const canRetry = !archived && (status === 'error' || awaitingSignIn);
  const [retryPending, setRetryPending] = useState(false);
  // Positions in `foldedItems` the user reverted via Edit-and-resend. Session-
  // scoped (a reload restores the failed pair from the CRDT log) — a wire-level
  // revert event would carry across reloads and clients, but the immediate
  // affordance is what the user typed against, so the hide lives here for now.
  const [revertedPositions, setRevertedPositions] = useState<ReadonlySet<number>>(new Set());
  // Mid-turn sends don't reject anymore — the server queues them behind the
  // active turn and drains FIFO (`ThreadInfo.queue`).
  const canQueue = !archived && turnActive;
  // Extract `pageList` once for the doc-path-link resolver. Follow-the-file
  // reads nothing from it any more — only write-shaped tool calls drive
  // navigation, so there is no "does the doc exist" gate left to arm. Kept
  // here to avoid per-message `useWorkspace` calls that would each fire a
  // `/api/workspace` fetch on web hosts.
  const pageList = useOptionalPageList();
  // Trust the last-known `pages` set even when the provider surfaces an
  // `error` from a background refetch: `PageListProvider.refetch` fires on
  // window focus / visibilitychange / CC1 `files` push and, on failure, sets
  // an error string WITHOUT clearing `serverPages`. Gating on `error === null`
  // here would flip the resolver null on a transient blip, remount every
  // Streamdown twice (drop → restore), and strip every doc link across the
  // transcript for the paint window between them.
  const pages =
    pageList !== null && !pageList.loading && pageList.pages.size > 0 ? pageList.pages : null;
  const docPathResolver = pages === null ? null : buildDocPathResolver({ workspace, pages });
  // Push into the module-scoped resolver DURING render so Streamdown's parse
  // (which happens synchronously inside its Block) sees the current value. A
  // `useEffect` write lands after the parse, leaving the first render of a
  // stable-text agent message unlinked. The write is idempotent (every
  // ThreadView derives from the same workspace + page list).
  setDocPathResolver(docPathResolver);
  const resolverReady = docPathResolver !== null;
  const transcriptFollowTarget = model !== null ? latestFollowTarget(model.items, workspace) : null;

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
  // In-flight guard for the plan-approval row. `sendText` is fire-and-forget
  // for a live thread and doesn't itself gate on `canPrompt`, so a
  // double-click would send twice before the status transitions to
  // `running`. Reset when the turn resumes (the send landed) or the plan
  // clears (a new turn started fresh).
  const [planApprovalPending, setPlanApprovalPending] = useState(false);

  // The turn actually ended — Stop worked (or the thread died with it).
  useEffect(() => {
    if (!turnActive) {
      setCancelPending(false);
      setCancelStalled(false);
    }
  }, [turnActive]);

  useEffect(() => {
    if (turnActive) setPlanApprovalPending(false);
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
      composerRef.current?.appendText(rescued.join('\n\n'));
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
    const text = composerText();
    const attachments = composerAttachments();
    if (text === '' && attachments.length === 0) return;
    client.steer(info.threadId, text, attachments.length > 0 ? attachments : undefined);
    composerRef.current?.clear();
    setPendingAttachments([]);
    setPendingUploads([]);
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
  const selectedCommentCount = useSelectedCommentCount();
  // The files the batch draws from — the chip says so when there is more than one.
  const selectedCommentDocs = useSelectedCommentDocs();
  // Ticked in the Comments panel = riding this message, so this starts ON — one
  // picker (the panel), and both composers default to carrying what it holds.
  // The chip's ✕ turns it off for this draft without disturbing the ticks.
  const [commentsAttached, setCommentsAttached] = useState(true);
  const hasQueuedComments = selectedCommentCount > 0 && commentsAttached;
  // A NEW comment re-attaches a dismissed batch, exactly as it does in the Ask
  // AI composer. The ✕ says "not this message" about the batch as it stood;
  // writing another one is a fresh statement of intent about the same message.
  // Both composers read one queue and show one chip, so a rule that held in only
  // one of them would make the same ✕ mean two different things depending on
  // which box you happened to be typing in.
  useEffect(() => subscribeCommentPosted(() => setCommentsAttached(true)), []);

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
    attachments: readonly AttachmentPart[] = [],
  ): Promise<boolean> => {
    const parts = attachments.length > 0 ? attachments : undefined;
    if (!archived) {
      client.prompt(info.threadId, text, parts);
      // Sending re-engages the live edge even if the reader had scrolled up.
      scrollApiRef.current?.scrollToEnd();
      return Promise.resolve(true);
    }
    setResumePending(true);
    setResumeError(null);
    setFailedPrompt(null);
    scrollApiRef.current?.scrollToEnd();
    return client
      .resumeThread(info.threadId, text, parts)
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

  /**
   * Send a revision of an already-sent message, either back into this
   * conversation or into a fresh one.
   *
   * The original turn is left alone. A transcript is the record of what the
   * agent was actually told, and the agent has already answered — rewriting the
   * bubble in place would leave its reply answering words that no longer appear
   * anywhere. So a revision is a new turn, which is also what lets it go to a
   * different thread at all.
   */
  const resendMessage = async (
    text: string,
    target: ResendTarget,
    attachments: readonly AttachmentPart[],
  ): Promise<boolean> => {
    if (target.kind === 'this-thread') {
      // `sendText` reports its own outcome: a live thread resolves true once the
      // prompt is dispatched, and an archived one resolves FALSE when the resume
      // it needs first fails.
      //
      // Null failure text, the escape hatch `failureText` documents for a caller
      // whose content survives elsewhere: on a failed resume the editor stays
      // open holding this revision AND its attachments, so also stashing it as a
      // failed prompt would offer a second, attachment-less copy of the same
      // words through the amber banner.
      return sendText(text, null, attachments);
    }
    // A new thread activates its own dock tab on arrival, so the revision lands
    // in front of the user without this surface reaching for focus.
    const outcome = await launchAgentThread(
      { source: target.agent.source, id: target.agent.id },
      text,
      null,
      null,
      null,
      attachments,
    );
    // A failed creation already toasted. A deduped one said nothing at all, and
    // here the revision exists nowhere but the field the caller is about to tear
    // down — so silence would read as the click doing nothing and lose it.
    if (outcome === 'deduped') {
      toast.error(t`Already starting a chat with this agent — try again in a moment.`);
    }
    return outcome === 'started';
  };

  const submit = (): void => {
    const text = composerText();
    const attachments = composerAttachments();
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
    // Attachments alone (image drop with no typed prose) still count as
    // content — the message is the picture. Otherwise a bare-empty draft
    // stays gated.
    if (text === '' && attachments.length === 0) return;
    void sendText(text, text, attachments);
    composerRef.current?.clear();
    setPendingAttachments([]);
    setPendingUploads([]);
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
  const submitQueuedComments = async (
    instruction: string,
    /**
     * Send exactly these instead of the whole checked queue. Set by the Comments
     * panel, whose This-doc scope counts one document's comments — the composer's
     * own chip leaves it unset, because that chip IS the whole checked queue.
     */
    threadIds?: readonly string[],
  ): Promise<void> => {
    // A mid-turn send only reaches the server's MESSAGE queue, and both a
    // cancel and a terminal status drop that queue before the agent ever reads
    // it. Resolving there would close review work nobody has acted on — the one
    // failure the comment queue exists to prevent — so the batch stays queued
    // until a send that actually runs. The message itself is really sent, so
    // the composer still clears; the toast is what explains the two facts
    // sitting side by side.
    const queuedBehindTurn = canQueue;
    const shipped = await dispatchComments({
      threadIds,
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
    composerRef.current?.clear();
    // Back to the default for the next message — a dispatched comment leaves the
    // queue server-side, so this only matters when a send left something behind.
    setCommentsAttached(true);
  };

  /**
   * The Comments panel sending a batch into THIS conversation.
   *
   * Runs the same path the composer's own send takes for an attached batch, so
   * a comment sent from the panel and one sent from the chip are one turn shape
   * and one resolve rule. Whatever is already typed rides along as the batch's
   * shared instruction rather than being cleared — you were in the middle of
   * saying something, and the comments are being added to it.
   *
   * An effect event, not a ref written during render: the subscription installs
   * once per thread id, and this has to read the CURRENT draft and thread status
   * at the moment the signal arrives.
   */
  const sendCommentsFromPanel = useEffectEvent((threadIds?: readonly string[]) => {
    // The composer's own guard: a busy thread accepts a queued message, a dead
    // one accepts nothing.
    if (!(canPrompt || canQueue)) return;
    submitQueuedComments(composerText(), threadIds).catch((err) => {
      console.warn('[acp] panel comment send rejected unexpectedly', err);
    });
  });

  // Keyed by thread id because every ThreadView stays mounted — an unkeyed
  // signal would send the batch from whichever thread answered first.
  useEffect(() => {
    return subscribeSendInThread((sendTo, threadIds) => {
      if (sendTo !== info.threadId) return;
      sendCommentsFromPanel(threadIds);
    });
  }, [info.threadId]);

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
    const draftText = composerText();
    const prompt = failedPrompt ?? (draftText === '' ? undefined : draftText);
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
  // added later is only retryable once someone decides it is. A prompt
  // failure takes a separate action (`restoreNoticeIndex` below) rather than
  // the launch-retrying Retry — the session is live, so a respawn is wrong
  // and re-sending happens through the composer instead. Failures a later
  // `ready` retired stay in the log but leave the screen — see `superseded`
  // in the fold. One list so the Retry / restore indexes and the render
  // cannot disagree about which row is which.
  // Two-stage fold: strip superseded notices first (fold-visible items keep
  // aligned indices with the transcript the reverse-scan walks), then hide
  // pairs the user reverted this session. `visibleItems` is what renders and
  // what `retryNoticeIndex` / `restoreNoticeIndex` index against.
  const foldedEntries =
    model === null
      ? []
      : model.items.flatMap((item, modelIndex) =>
          item.kind !== 'notice' || item.superseded !== true ? [{ item, modelIndex }] : [],
        );
  const foldedItems = foldedEntries.map((entry) => entry.item);
  // Each visible row keeps the `model.items` position it came from, rather than
  // that being rebuilt alongside and re-paired by ordinal. Both filters remove
  // items, so a visible position shifts when one lands ahead of it, and the
  // React key is what holds a bubble (and the revision being typed in it)
  // mounted. Of the three index spaces only `model.items` is append-only, and
  // only for as long as the thread's model builder lives: archiving a live
  // thread discards it, which unmounts the whole view rather than a row.
  //
  // `foldedItems` and the visible ordinal both stay, since six index maps read
  // those.
  const visibleEntries = foldedEntries.filter((_, index) => !revertedPositions.has(index));
  const visibleItems = visibleEntries.map((entry) => entry.item);
  // Read off the unfiltered fold: a warning is never superseded and never
  // reverted, so what the announcer sees is what the agent actually sent.
  const agentNotices =
    model === null
      ? []
      : model.items.flatMap((item) =>
          item.kind === 'agent_notice' ? [{ seq: item.seq, text: item.text }] : [],
        );
  let retryNoticeIndex = -1;
  if (canRetry) {
    for (let index = visibleItems.length - 1; index >= 0; index -= 1) {
      const item = visibleItems[index];
      if (item?.kind === 'notice' && item.failure !== null && isRetryableFailure(item.failure)) {
        retryNoticeIndex = index;
        break;
      }
    }
  }
  // The action that turns a failed-prompt card into a way forward. The card
  // itself doesn't reveal the message text (that's the preceding user bubble),
  // so a "just retype it" workaround is the friction here — long prompts, or
  // ones tuned once that the user wants to send again under a setting they
  // just changed. Only the most-recent prompt failure carries the button,
  // mirroring Retry's one-card discipline; older failures stay in the log
  // as history.
  let restoreNoticeIndex = -1;
  if (!archived && status !== 'exited') {
    for (let index = visibleItems.length - 1; index >= 0; index -= 1) {
      const item = visibleItems[index];
      if (item?.kind === 'notice' && item.failure?.reason === 'prompt') {
        restoreNoticeIndex = index;
        break;
      }
    }
  }
  const restoreFailedPromptToComposer = (visibleNoticeIndex: number): void => {
    // Translate the visibleItems index into a foldedItems index (visibleItems
    // drops previously-reverted positions), then walk back for the failed
    // prompt's OWN user row. Stop at the first `role === 'user'` regardless
    // of text: an attachment-only prompt lands as a real user item with
    // `text: ''` in the fold, so an empty-text predicate here would step
    // past it and pull text from an earlier, unrelated turn. On success,
    // seed the composer AND hide the failed pair — the user's mental model
    // is that Edit-and-resend replaces the send, not appends alongside it.
    const foldedNoticeIndex = mapVisibleToFolded(visibleNoticeIndex);
    if (foldedNoticeIndex === -1) return;
    for (let index = foldedNoticeIndex - 1; index >= 0; index -= 1) {
      const item = foldedItems[index];
      if (item?.kind === 'message' && item.role === 'user') {
        if (item.text !== '') {
          composerRef.current?.appendText(item.text);
          scrollApiRef.current?.scrollToEnd();
        }
        setRevertedPositions((prev) => {
          const next = new Set(prev);
          next.add(index);
          next.add(foldedNoticeIndex);
          return next;
        });
        return;
      }
    }
  };
  // Visible indices skip previously-reverted foldedItems positions. Walk
  // foldedItems, counting only positions that pass the revert filter, until
  // we reach the requested visible index.
  const mapVisibleToFolded = (target: number): number => {
    let seen = -1;
    for (let index = 0; index < foldedItems.length; index += 1) {
      if (revertedPositions.has(index)) continue;
      seen += 1;
      if (seen === target) return index;
    }
    return -1;
  };

  // The newest sent message keeps its actions on screen rather than waiting for
  // a hover. Sending a revision to a DIFFERENT agent is a capability nothing
  // else in the app points at, so hiding every entry point behind a hover would
  // leave it undiscovered; showing it on one turn surfaces it per thread
  // without doubling the chrome down a long transcript.
  let lastUserTurnIndex = -1;
  for (let index = visibleItems.length - 1; index >= 0; index -= 1) {
    const item = visibleItems[index];
    if (item?.kind === 'message' && item.role === 'user') {
      lastUserTurnIndex = index;
      break;
    }
  }

  // A thread waiting on sign-in has nothing else to show: it never opened a
  // session, so its transcript is startup diagnostics the sign-in supersedes.
  // The prompt takes the whole pane rather than sitting under a stack of alert
  // cards repeating the same sentence, one per failed attempt.
  const items = visibleItems;
  let authPrompt: ThreadFailureDetail | null = null;
  if (awaitingSignIn && !archived) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.kind === 'notice' && item.failure?.reason === 'auth-required') {
        authPrompt = item.failure;
        break;
      }
    }
  }

  return (
    <ImagePreviewContext.Provider value={openImagePreview}>
      <ImagePreviewDialog
        preview={imagePreview}
        onOpenChange={(open) => !open && setImagePreview(null)}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop-target — keyboard/AT users have the + picker button in the composer; drop is a pointer-only affordance. */}
      <div
        className="relative flex min-h-0 flex-1 flex-col text-gray-800 dark:text-gray-200"
        data-agent-thread-root=""
        onDragEnter={(event) => {
          // `types.includes('Files')` — filter DOM drags (text, page elements)
          // out; only real file drops raise the overlay. `preventDefault` on
          // dragenter keeps the browser from opening the file in a new tab
          // when the drop misses our handlers below.
          if (event.dataTransfer?.types.includes('Files')) {
            event.preventDefault();
            setDragActive(true);
          }
        }}
        onDragOver={(event) => {
          if (event.dataTransfer?.types.includes('Files')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDragLeave={(event) => {
          // Only dismiss when the drag actually leaves the whole panel — child
          // dragleaves (crossing between the overlay and inner UI) fire this
          // too, and dropping the overlay mid-drag flickers.
          if (event.currentTarget === event.target) setDragActive(false);
        }}
        onDrop={(event) => {
          const files = collectAllFiles(event.dataTransfer);
          if (files.length === 0) return;
          event.preventDefault();
          setDragActive(false);
          void ingestFiles(files);
        }}
      >
        <DocPathResolverReadyContext value={resolverReady}>
          <ThreadHeader info={info} followFile={followFile} onToggleFollow={toggleFollow} />
          {/* Outside every transcript branch so it is mounted before the first
              warning can arrive, whichever branch is on screen. */}
          <AgentNoticeAnnouncer
            notices={agentNotices}
            agentName={agentDisplayName(info.agent.name)}
            replayThroughSeq={state?.replayThroughSeq ?? Number.POSITIVE_INFINITY}
          />
          {model !== null && model.plan.length > 0 ? (
            <PlanChecklist
              plan={model.plan}
              approval={
                canPrompt && !archived && !planApprovalPending
                  ? {
                      onApprove: () => {
                        setPlanApprovalPending(true);
                        // Sent verbatim to the coding agent — English keeps
                        // this out of the user's UI locale, matching the
                        // codebase's existing agent-directed instruction
                        // precedent. Ask changes below lands in the composer
                        // for the user to edit, so it stays i18n'd.
                        void sendText('Approve. Please proceed with the plan.');
                      },
                      onAskChanges: () => {
                        // Idempotent by intent: skip the append when the
                        // composer already ends with our prefix so double-
                        // clicks don't stack duplicate leaders.
                        const prefix = t`In the plan above, please `;
                        const composer = composerRef.current;
                        if (
                          composer !== null &&
                          !composer.getContent().instruction.endsWith(prefix)
                        ) {
                          composer.appendText(prefix);
                        }
                        composer?.focusEnd();
                      },
                      onReject: () => {
                        setPlanApprovalPending(true);
                        void sendText('Reject. Please stop and do not proceed with this plan.');
                      },
                    }
                  : undefined
              }
            />
          ) : null}
          {authPrompt !== null || model === null || visibleItems.length === 0 ? (
            // No messages yet: the empty state centers itself via `h-full`, which needs
            // a plain definite-height block host. The scroller's managed flex layout
            // won't provide one, so only real transcripts go through the scroller.
            <div
              className="min-h-0 flex-1 overflow-y-auto px-3 py-2 subtle-scrollbar scroll-fade-mask"
              data-testid="agent-thread-transcript"
            >
              {authPrompt !== null ? (
                <div className="flex min-h-full items-center justify-center">
                  <ThreadAuthPrompt
                    failure={authPrompt}
                    agent={info.agent}
                    agentName={agentDisplayName(info.agent.name)}
                    signingIn={signingIn}
                    signInOutput={info.signInOutput}
                    showRetry={canRetry}
                    retryPending={retryPending}
                    onRetry={retryThread}
                    onAuthenticate={authenticateThread}
                  />
                </div>
              ) : (
                <ThreadEmptyState status={status} archived={archived} agent={info.agent} />
              )}
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
                    {visibleEntries.map(({ item, modelIndex }, index) => {
                      const id = transcriptItemId(item, modelIndex);
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
                            streaming={turnActive && index === visibleItems.length - 1}
                            terminals={model.terminals}
                            permissionsByToolCall={model.permissionsByToolCall}
                            showRetry={index === retryNoticeIndex}
                            retryPending={retryPending}
                            onRetry={retryThread}
                            showRestore={index === restoreNoticeIndex}
                            onRestore={() => restoreFailedPromptToComposer(index)}
                            onResend={resendMessage}
                            // Only the "send it here" destination needs this
                            // thread alive. A revision handed to a fresh thread
                            // never touches it — and a crashed agent is exactly
                            // when handing the prompt to a different one is
                            // worth the most.
                            canSendHere={canPrompt || canQueue}
                            isLatestUserTurn={index === lastUserTurnIndex}
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
                        <Spinner className="size-3.5" aria-hidden="true" />
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
          <div role="status" aria-live="polite" data-testid="agent-thread-drop-notice">
            {dropNotice !== null ? (
              <div className="border-t bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs">
                {dropNotice.text}
              </div>
            ) : null}
          </div>
          {info.steer !== undefined && !archived ? (
            <div
              className="flex items-center gap-2 border-t bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs"
              data-testid="agent-thread-steer-pending"
            >
              <Spinner className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="shrink-0">{t`Steering — waiting for the current run to stop…`}</span>
              <span className="min-w-0 flex-1 truncate text-foreground/80">
                {info.steer.content}
              </span>
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
            composerRef={composerRef}
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
            selectedCommentCount={selectedCommentCount}
            selectedCommentDocs={selectedCommentDocs}
            hasQueuedComments={hasQueuedComments}
            onAttachComments={() => setCommentsAttached(true)}
            onDismissComments={() => setCommentsAttached(false)}
            pendingAttachments={pendingAttachments}
            pendingUploads={pendingUploads}
            imagesAccepted={imagesAccepted}
            onIngestImageFiles={ingestFiles}
            onIngestAllFiles={ingestFiles}
            onRemovePendingAttachment={removePendingAttachment}
          />
          {dragActive ? <ChatPanelDropOverlay onDismiss={() => setDragActive(false)} /> : null}
        </DocPathResolverReadyContext>
      </div>
    </ImagePreviewContext.Provider>
  );
}

/**
 * Warns when the agent is verified to act without ever asking — the one
 * posture with no signal anywhere else in the UI: no permission prompts
 * will appear, and without declared modes the settings trigger has no
 * permissive-mode accent to show. Milder postures (asks-first, governed by
 * the agent's own mode) stay badge-free on purpose — those are already
 * legible from the permission prompts and the settings trigger, and a
 * badge repeating them would be noise.
 */
function PermissionPostureBadge({ info }: { info: ThreadInfo }): ReactNode {
  const { t } = useLingui();
  if (deriveAgentPosture(info.agent.id, info.modes) !== 'autonomous') return null;
  const label = t`${info.agent.name} acts without asking — OpenKnowledge can't add permission prompts for it`;
  // Short name so the focusable span below stays on one line — the biome
  // suppression only reaches the line directly after it.
  const focusRing =
    'inline-flex rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a status indicator whose detail lives in its tooltip must be focusable or keyboard users can never surface it — same rationale as the tooltip-on-disabled-button span wrapper. */}
        <span tabIndex={0} role="img" aria-label={label} className={focusRing}>
          <span
            className="inline-flex shrink-0 text-amber-500 dark:text-amber-400"
            data-testid="agent-thread-posture"
          >
            <ShieldAlert className="size-3.5" aria-hidden="true" />
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">
        {label}
      </TooltipContent>
    </Tooltip>
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
        <PermissionPostureBadge info={info} />
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

/**
 * One stable trigger for every setting an ACP agent advertises. Renders for
 * every agent: when this one advertises nothing the trigger stays visible
 * but disabled, with the reason on it — a control that silently vanishes on
 * an agent switch reads as breakage, not as a capability difference.
 */
function AgentSettingsPopover({ info }: { info: ThreadInfo }): ReactNode {
  const { t } = useLingui();
  const reasonId = useId();
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
  if (configOptions.length === 0 && !showLegacyModes) {
    // Options arrive with `session/new`; until the thread has been ready
    // once, "none yet" is indistinguishable from "none ever", and the reason
    // must not claim the agent said no before it answered. An exited thread
    // (archived ones rehydrate as exited) DID answer — its session ran to
    // completion without advertising anything. `error` stays unsettled: a
    // crash before `session/new` really did leave the question unanswered.
    const settled =
      info.status === 'ready' ||
      info.status === 'running' ||
      info.status === 'awaiting_permission' ||
      info.status === 'exited';
    const reason = settled
      ? t`${info.agent.name} doesn't offer any settings to adjust`
      : t`${info.agent.name} hasn't reported its settings yet`;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* The trigger sits on a wrapping span so Radix puts its own
              `aria-describedby` there while the button keeps pointing at the
              reason below. */}
          <span className="inline-flex cursor-not-allowed">
            <Button
              type="button"
              variant="ghost"
              className="h-6 max-w-48 gap-1 rounded-md pl-1.5 pr-1! text-xs"
              aria-label={t`Agent settings`}
              // `aria-disabled` rather than `disabled`: a natively disabled
              // button leaves the tab order, so a keyboard user could never
              // reach the tooltip or this description explaining why it
              // won't act.
              aria-disabled
              aria-describedby={reasonId}
              data-testid="agent-thread-settings"
            >
              <span className="truncate text-muted-foreground/50">{t`Settings`}</span>
              <ChevronDown
                className="size-3.5 text-muted-foreground/50"
                data-icon="inline-end"
                aria-hidden="true"
              />
            </Button>
            <span id={reasonId} className="sr-only">
              {reason}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{reason}</TooltipContent>
      </Tooltip>
    );
  }

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
  // The archived caveat rides the trigger's label as well as the row inside the
  // menu: a menu label is a bare div outside the roving-focus collection and
  // outside the menu's accessible name, so on its own it would leave exactly
  // the "picked it and nothing happened" impression it exists to prevent for
  // anyone not reading the menu visually.
  const accentTooltip =
    info.archived === true
      ? t`Agent settings — changes apply when you pick this conversation back up`
      : permissiveMode && modeSurface !== null
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
        {/* An archived thread has no agent to apply a pick to — the server
            records it against the thread and the resume starts on it. Without
            saying so, a pick that visibly sticks but changes nothing until you
            send a message is indistinguishable from a menu that silently
            failed. */}
        {info.archived === true ? (
          <DropdownMenuLabel
            className="font-normal text-muted-foreground"
            data-testid="agent-thread-settings-archived-hint"
          >
            {t`Applies when you pick this conversation back up`}
          </DropdownMenuLabel>
        ) : null}
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

  // Waiting on sign-in with nothing to sign in WITH: the agent reported the
  // status but named no method, so this is only the state, in the same shape
  // the sign-in prompt uses when it does have methods to offer.
  if (status === 'auth_required') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <RegisteredAgentIcon
          agentId={agent.id}
          iconUrl={agent.iconUrl}
          className="size-12 opacity-25 grayscale"
        />
        <p className="text-muted-foreground text-sm">{t`Sign in to ${agentName} to continue.`}</p>
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
        : status === 'authenticating'
          ? t`Signing in to ${agentName}…`
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
  showRestore,
  onRestore,
  onResend,
  canSendHere,
  isLatestUserTurn,
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
  /** This notice is the one that offers Edit-and-resend (at most one). */
  showRestore: boolean;
  onRestore: () => void;
  /** Re-send a revision of a sent message. Settles false when the send demonstrably
   *  did not happen: a deduped or failed launch, or an archived thread whose resume
   *  rejected. True on a live thread means dispatched, not acknowledged. */
  onResend: (
    text: string,
    target: ResendTarget,
    attachments: readonly AttachmentPart[],
  ) => Promise<boolean>;
  /** Whether THIS thread still accepts sends. Gates only the same-thread
   *  destination; the new-thread ones never needed it. */
  canSendHere: boolean;
  /** This is the transcript's last sent message. Its actions stay visible
   *  rather than waiting for a hover. */
  isLatestUserTurn: boolean;
}): ReactNode {
  switch (item.kind) {
    case 'message':
      return (
        <MessageBubble
          item={item}
          streaming={streaming}
          agent={agent}
          onResend={onResend}
          canSendHere={canSendHere}
          isLatestUserTurn={isLatestUserTurn}
        />
      );
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
    case 'pi_bridge':
      return <PiBridgeConsentPrompt item={item} threadId={threadId} />;
    case 'notice':
      return (
        <ThreadNotice
          item={item}
          agentName={agentDisplayName(agent.name)}
          showRetry={showRetry}
          retryPending={retryPending}
          onRetry={onRetry}
          showRestore={showRestore}
          onRestore={onRestore}
        />
      );
    case 'agent_notice':
      return <AgentNoticeCard item={item} />;
  }
}

/**
 * Runtime status the agent reported mid-turn, drawn as chrome so it cannot be
 * read as part of the answer.
 *
 * Severity is carried three ways — the written label, the glyph and the box's
 * own border — because color alone is unavailable to a reader who cannot see
 * it and is replaced outright by system colors under forced-colors mode. The
 * border survives both, which is why the box is the load-bearing cue and the
 * amber fill is only reinforcement.
 *
 * Passive by construction: `role="note"` rather than `alert`, and the card
 * itself offers no dismissal and no action, so a replayed transcript re-draws
 * it without interrupting and without offering the reader a control that would
 * do nothing. Arrival announcement is the thread-level live region's job, not
 * this row's.
 *
 * The agent's own words go through the same renderer as its replies and are
 * neither translated nor trimmed — only the surrounding label is app copy.
 */
function AgentNoticeCard({
  item,
}: {
  item: Extract<RenderedItem, { kind: 'agent_notice' }>;
}): ReactNode {
  const { t } = useLingui();
  return (
    <div
      role="note"
      className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-xs"
      data-testid="agent-thread-agent-notice"
    >
      <p className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
        <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        {t`Warning`}
      </p>
      <div className="mt-1 wrap-break-word text-foreground">
        <AgentMarkdown text={item.text} />
      </div>
    </div>
  );
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
 * What the agent printed while signing in. A device-code flow gets the code as
 * the focus (large, monospaced, one tap to copy — the user has to match it
 * against their browser character for character) with the confirmation URL
 * beneath it. Anything unrecognized falls through verbatim, because this stderr
 * is the only channel a sign-in has before a session exists.
 */
function SignInOutput({ output }: { output?: string[] }): ReactNode {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  // Timer owned by an effect, not the click handler: the panel unmounts the
  // moment the sign-in resolves, which can land inside this window.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COMPLETION_CHECK_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const parsed = output === undefined || output.length === 0 ? null : parseSignInOutput(output);
  const empty =
    parsed === null ||
    (parsed.code === undefined && parsed.url === undefined && parsed.lines.length === 0);

  const copyCode = (value: string): void => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => setCopied(true))
      .catch(() => {
        // No clipboard (insecure context, denied permission) — the code is on
        // screen and selectable, so there is nothing to recover from.
      });
  };

  // Mounted unconditionally and starting empty: a live region added and filled
  // in the same render is missed on VoiceOver/Safari. Copying gives sighted
  // users an icon swap, which is nothing at all without the announcement.
  const liveRegion = (
    <div className="sr-only" role="status" aria-live="polite">
      {copied ? t`Code copied` : ''}
    </div>
  );
  if (empty) return liveRegion;
  const { code, url, lines } = parsed;

  return (
    <div
      className="mt-1 flex flex-col items-center gap-1.5"
      data-testid="agent-thread-sign-in-output"
    >
      {liveRegion}
      {code !== undefined ? (
        <Button
          type="button"
          variant="outline"
          className="h-auto w-full select-text py-1.5 font-mono text-base tracking-[0.2em]"
          onClick={() => copyCode(code)}
          aria-label={t`Copy the code ${code}`}
          data-testid="agent-thread-sign-in-code"
        >
          {copied ? <Check className="size-3.5" aria-hidden="true" /> : null}
          {code}
        </Button>
      ) : null}
      {url !== undefined ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
          onClick={(e) => dispatchExternalLinkClick(e, url)}
          onAuxClick={(e) => dispatchExternalLinkClick(e, url)}
          data-testid="agent-thread-sign-in-url"
        >
          {shortenUrl(url)}
        </a>
      ) : null}
      {lines.length > 0 ? (
        <p className="select-text text-muted-foreground text-xs">{lines.join(' ')}</p>
      ) : null}
    </div>
  );
}

/**
 * Sign-in, rendered as the thread's own front door rather than an alert: the
 * agent's mark, its name, and the ways in. Untinted on purpose — needing an
 * account is a step in starting an agent, not a fault to warn about — and only
 * the first method carries the primary weight, so several ways in still read
 * as one decision instead of a row of equal demands.
 */
function ThreadAuthPrompt({
  failure,
  agent,
  agentName,
  signingIn,
  signInOutput,
  showRetry,
  retryPending,
  onRetry,
  onAuthenticate,
}: {
  failure: ThreadFailureDetail;
  agent: ThreadInfo['agent'];
  agentName: string;
  /** The server has an `authenticate` in flight for this thread. */
  signingIn: boolean;
  /** What the agent printed during the sign-in — a device code, a URL. */
  signInOutput?: string[];
  showRetry: boolean;
  retryPending: boolean;
  onRetry: () => void;
  onAuthenticate: (methodId: string) => Promise<void>;
}): ReactNode {
  const { t } = useLingui();
  const [showDetail, setShowDetail] = useState(false);
  const [authPending, setAuthPending] = useState<string | null>(null);
  const authMethods = failure.authMethods ?? [];
  // `env_var` / `terminal` methods are completed in the user's own shell or
  // environment — OK can name them, but the protocol gives it no way to carry
  // out the sign-in, so they get no button. Retry below is how the user says
  // they did it. Everything else (including the default agent-driven kind) is
  // an `authenticate` call OK can make itself.
  const signInMethods = authMethods.filter((m) => m.kind !== 'terminal' && m.kind !== 'env_var');
  const manualMethods = authMethods.filter((m) => m.kind === 'terminal' || m.kind === 'env_var');
  const agentMessage = failure.agentMessage ?? '';
  const machineDetail = failure.machineDetail ?? '';
  const framedRetry = showRetry && machineDetail === '' && !signingIn;
  const signIn = (methodId: string): void => {
    setAuthPending(methodId);
    void onAuthenticate(methodId)
      .catch((err: unknown) => {
        toast.error(t`Sign-in failed: ${errorText(err)}`);
      })
      .finally(() => setAuthPending(null));
  };
  return (
    <div
      className="mx-auto flex w-full max-w-72 flex-col items-center gap-4 px-2 py-6 text-center"
      data-testid="agent-thread-notice"
    >
      <RegisteredAgentIcon
        agentId={agent.id}
        iconUrl={agent.iconUrl}
        className="size-12 opacity-25 grayscale"
      />
      {/* The panel swaps its whole headline when the sign-in starts, and a
          swapped paragraph is a silent change: the shimmer reads as progress
          to anyone who can see it and as nothing at all to anyone who cannot.
          Mounted empty from the first render so the announcement is not lost
          to a region that appears and fills in the same cycle. WCAG 4.1.3. */}
      <div className="sr-only" role="status" aria-live="polite">
        {signingIn ? t`Signing in to ${agentName}` : ''}
      </div>
      <div className="flex flex-col gap-1">
        {signingIn ? (
          <>
            <p className="shimmer font-medium text-sm">{t`Signing in to ${agentName}…`}</p>
            <SignInOutput output={signInOutput} />
          </>
        ) : (
          <>
            <p className="font-medium text-foreground text-sm">{t`Sign in to ${agentName} to continue.`}</p>
            {agentMessage !== '' ? (
              <p className="text-muted-foreground text-1sm">{agentMessage}</p>
            ) : null}
          </>
        )}
      </div>
      {!signingIn && signInMethods.length > 0 ? (
        <div className="flex w-full flex-col gap-1.5">
          {signInMethods.map((method, index) => (
            <Button
              key={method.id}
              type="button"
              size="sm"
              // The agent lists its methods best-first, so the first one leads
              // and the rest stay available without competing with it.
              variant={index === 0 ? 'default' : 'outline-mono'}
              className="w-full"
              disabled={authPending !== null}
              onClick={() => signIn(method.id)}
              data-testid="agent-thread-auth-method"
              data-auth-method-id={method.id}
            >
              {authPending === method.id ? (
                <Spinner className="size-3.5" aria-hidden="true" />
              ) : null}
              {/* One method is the whole choice, so the button says what it
                  does; several are a menu, and the names are the choice. */}
              {signInMethods.length === 1 ? t`Sign in with ${method.name}` : method.name}
            </Button>
          ))}
        </div>
      ) : null}
      {!signingIn && manualMethods.length > 0 ? (
        <ul className="flex flex-col gap-1 text-muted-foreground text-xs">
          {manualMethods.map((method) => (
            <li key={method.id} data-testid="agent-thread-auth-manual">
              {method.description !== undefined && method.description !== ''
                ? `${method.name} — ${method.description}`
                : method.name}
            </li>
          ))}
        </ul>
      ) : null}
      {showRetry || machineDetail !== '' ? (
        <div className={cn('flex items-center', framedRetry ? 'gap-1.5' : 'gap-3')}>
          {framedRetry ? (
            <span className="text-muted-foreground text-xs">{t`Already signed in?`}</span>
          ) : null}
          {showRetry ? (
            <Button
              type="button"
              variant="link-muted"
              size="xs"
              className="h-auto p-0"
              disabled={retryPending}
              onClick={onRetry}
              data-testid="agent-thread-retry"
            >
              {retryPending ? (
                <>
                  <Spinner className="size-3" aria-hidden="true" />
                  {t`Retrying…`}
                </>
              ) : (
                t`Retry`
              )}
            </Button>
          ) : null}
          {machineDetail !== '' ? (
            <Button
              type="button"
              variant="link-muted"
              size="xs"
              className="h-auto p-0"
              onClick={() => setShowDetail((open) => !open)}
              aria-expanded={showDetail}
              data-testid="agent-thread-notice-details-toggle"
            >
              {showDetail ? t`Hide details` : t`Show details`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {showDetail && machineDetail !== '' ? (
        <pre
          className="w-full overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-left font-mono text-[10px] text-muted-foreground"
          data-testid="agent-thread-notice-details"
        >
          {machineDetail}
        </pre>
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
  showRestore,
  onRestore,
}: {
  item: Extract<RenderedItem, { kind: 'notice' }>;
  agentName: string;
  showRetry: boolean;
  retryPending: boolean;
  onRetry: () => void;
  showRestore: boolean;
  onRestore: () => void;
}): ReactNode {
  const { t } = useLingui();
  const [showDetail, setShowDetail] = useState(false);
  const failure = item.failure;
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
  const rootCauseLine =
    failure?.machineDetail !== undefined && failure.machineDetail !== ''
      ? extractRootCauseLine(failure.machineDetail)
      : null;
  return (
    <div
      className={cn(
        'rounded-md border px-2 py-1.5 text-xs',
        item.tone === 'error'
          ? 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400'
          : 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400',
      )}
      data-testid="agent-thread-notice"
      data-notice-attempts={item.attempts}
    >
      {failure === null ? (
        item.text
      ) : (
        <>
          <p>
            {headline}
            {item.attempts > 1 ? (
              <span className="ml-1.5 opacity-70" data-testid="agent-thread-notice-attempts">
                {t`(${plural(item.attempts, { one: '# attempt', other: '# attempts' })})`}
              </span>
            ) : null}
          </p>
          {failure.agentMessage !== undefined && failure.agentMessage !== '' ? (
            <p className="mt-1 opacity-80">{failure.agentMessage}</p>
          ) : null}
          {rootCauseLine !== null ? (
            // The one line the reader actually needs — pulled out of the
            // stderr wall so they don't have to expand "Show details" and
            // scan for `npm error` / `Error:` themselves.
            <p
              className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px]"
              data-testid="agent-thread-notice-root-cause"
            >
              {rootCauseLine}
            </p>
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
                  {highlightStderr(failure.machineDetail)}
                </pre>
              ) : null}
            </>
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
                    <Spinner className="size-3" aria-hidden="true" />
                    {t`Retrying…`}
                  </>
                ) : (
                  t`Retry`
                )}
              </Button>
            </div>
          ) : null}
          {showRestore ? (
            <div className="mt-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                onClick={onRestore}
                data-testid="agent-thread-restore"
              >
                {t`Edit and resend`}
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
  agent,
  onResend,
  canSendHere,
  isLatestUserTurn,
}: {
  item: Extract<RenderedItem, { kind: 'message' }>;
  streaming?: boolean;
  /** The agent answering this thread — the "new chat" default in the editor's
   *  send menu. */
  agent: ThreadInfo['agent'];
  /** Re-send a revision of this message. Resolves false when the send demonstrably
   *  did not happen: a launch the dedup guard swallowed or that failed to create,
   *  or an archived thread whose resume rejected. On a live thread the prompt is
   *  dispatched fire-and-forget, so true there means handed to the socket, not
   *  acknowledged. */
  onResend: (
    text: string,
    target: ResendTarget,
    attachments: readonly AttachmentPart[],
  ) => Promise<boolean>;
  /** Whether this thread still accepts sends. Only the same-thread destination
   *  is withdrawn without it — Edit stays, because a revision can still be
   *  handed to a fresh thread. */
  canSendHere: boolean;
  /** The transcript's last sent message keeps its actions on screen. */
  isLatestUserTurn: boolean;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  // Assigned by every close, so it always describes the most recent one rather
  // than latching. State rather than an unconditional autofocus because a bubble
  // that remounts for any other reason must not pull focus out of wherever the
  // reader actually is.
  const [restoreFocus, setRestoreFocus] = useState(false);
  // Bumped by every open and every close. `onSend` awaits, so its continuation
  // outlives the editor that started it: cancelling a slow send, reopening and
  // retyping would otherwise let the abandoned one tear down the SECOND editor
  // and take that revision with it.
  const editSession = useRef(0);
  const openEditor = (): void => {
    editSession.current += 1;
    setEditing(true);
  };
  const closeEditor = (restore: boolean): void => {
    editSession.current += 1;
    setEditing(false);
    setRestoreFocus(restore);
  };
  if (item.role === 'thought') {
    return <ThoughtBlock item={item} streaming={streaming === true} />;
  }
  if (item.role !== 'user') {
    return (
      // Agent reply reads as full-width prose — no bubble, no fill.
      <div
        className="w-full wrap-break-word text-sm text-foreground"
        data-testid="agent-thread-agent-message"
      >
        {/* Rendered as markdown, by the same renderer that sanitizes the
            transcript's other prose. */}
        <AgentMarkdown text={item.text} />
      </div>
    );
  }
  const attachments = item.attachments;
  return (
    // The hover scope spans the bubble AND the action row beneath it, so
    // travelling from the words to the buttons never crosses un-hovered ground
    // and blinks them away. Extra vertical margin (on top of the transcript's
    // gap-2) enlarges only the turn boundary — the gap before the agent's
    // response starts — while the response's own items stay tight.
    <div
      className={cn(
        'group/user-message my-3 ml-auto flex flex-col',
        // Editing needs the room the read view doesn't: a revision is typed,
        // not skimmed, and 85% of a docked panel is a column too narrow to work
        // a paragraph in.
        editing ? 'w-full' : 'max-w-[85%]',
      )}
    >
      <div
        className={cn(
          // Sent-message bubble: light-gray fill, right-aligned, with the
          // squared bottom-right corner (the sender-side "tail").
          // No `whitespace-pre-wrap`: it fights the renderer, which decides its
          // own block spacing. The cost is that a single newline in a typed
          // message collapses, the way it does in any markdown chat.
          'wrap-break-word rounded-2xl rounded-br-xs bg-muted text-sm text-foreground',
          editing ? 'p-2' : 'px-3 py-1.5',
        )}
        data-testid="agent-thread-user-message"
      >
        {editing ? (
          <UserMessageEditor
            initialText={item.text}
            currentAgent={agent}
            canSendHere={canSendHere}
            onCancel={() => closeEditor(true)}
            onSend={async (text, target, chips) => {
              // The original message's parts ride along: a revision of "look at
              // this screenshot and…" that arrived without the screenshot is a
              // different ask. Chips typed into the revision itself are added,
              // not substituted.
              //
              // Awaited, so a send that reports back as not-having-happened
              // leaves the field standing. The revision exists nowhere else, so
              // closing on a launch that turns out to be swallowed would delete
              // what was typed.
              const session = editSession.current;
              if (!(await onResend(text, target, [...(attachments ?? []), ...chips]))) return;
              // Whoever is in the field now did not start this send.
              if (editSession.current !== session) return;
              // Focus goes back to the turn only when the answer arrives here.
              // A new thread activates its own dock tab and moves focus into
              // that composer, so reaching for it would teleport twice and land
              // the user on a control that no longer describes their state.
              closeEditor(target.kind === 'this-thread');
            }}
          />
        ) : (
          <>
            {/* Both sides render as markdown. Sent messages used to print
                verbatim, which was fine for a typed sentence and wrong for a
                comment batch: that prompt is composed markdown, so the reader
                saw the raw `>` blockquotes and backticks the agent parses
                rather than the passages they mark. */}
            <AgentMarkdown text={item.text} />
            {attachments !== undefined && attachments.length > 0 ? (
              <UserMessageAttachments attachments={attachments} />
            ) : null}
          </>
        )}
      </div>
      {editing ? null : (
        <UserMessageActions
          text={item.text}
          sentAt={item.sentAt}
          alwaysVisible={isLatestUserTurn}
          restoreFocus={restoreFocus}
          onEdit={openEditor}
        />
      )}
    </div>
  );
}

/** Full-image preview overlay opened by clicking an image tile. Uses the
 *  shared shadcn Dialog; wider than the settings default so a screenshot
 *  isn't squeezed. `object-contain` preserves the image's own aspect ratio;
 *  capped at ~90 vw / 90 dvh so it never leaves the window. Radix requires
 *  a DialogTitle for AT — the image `name` supplies it, sr-only so the
 *  panel reads image-first. */
function ImagePreviewDialog({
  preview,
  onOpenChange,
}: {
  preview: ImagePreview | null;
  onOpenChange: (open: boolean) => void;
}): ReactNode {
  const { t } = useLingui();
  return (
    <Dialog open={preview !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(90dvh,900px)] items-center justify-center bg-background p-2 sm:max-w-[min(90vw,1000px)]"
        data-testid="agent-thread-image-preview"
      >
        <DialogTitle className="sr-only">{preview?.name ?? t`Image preview`}</DialogTitle>
        {preview !== null ? (
          <img
            src={preview.src}
            alt={preview.name}
            className="max-h-[min(85dvh,850px)] max-w-full rounded object-contain"
            draggable={false}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Object-identity → stable React key mapping for attachments. `@`-mention +
 * drop can produce two `AttachmentPart` values with identical `kind`, `path`,
 * and `name` on the same message; hashing their content collides. Object
 * identity is the only field that distinguishes them, so we key off it via a
 * WeakMap that the GC drains as sent messages fall out of the transcript
 * window. Assigned on first read so per-attachment keys stay stable across
 * re-renders of the same message.
 */
const attachmentKeys = new WeakMap<object, string>();
let attachmentKeyCounter = 0;
function keyForAttachment(attachment: AttachmentPart): string {
  const existing = attachmentKeys.get(attachment);
  if (existing !== undefined) return existing;
  attachmentKeyCounter += 1;
  const key = `att-${attachmentKeyCounter}`;
  attachmentKeys.set(attachment, key);
  return key;
}

/**
 * Read-only chip strip beside a sent user message. Files/folders render as
 * `@path` pills (matching the composer's chip look), images as small square
 * thumbnails. Never removable — a sent message is frozen.
 */
function UserMessageAttachments({
  attachments,
}: {
  attachments: readonly AttachmentPart[];
}): ReactNode {
  const openPreview = use(ImagePreviewContext);
  return (
    <div
      className="mt-1.5 flex flex-wrap justify-end gap-1.5"
      data-testid="agent-thread-user-message-attachments"
    >
      {attachments.map((attachment) => {
        const key = keyForAttachment(attachment);
        if (attachment.kind === 'image') {
          const src = `data:${attachment.mimeType};base64,${attachment.data}`;
          return (
            <Button
              key={key}
              type="button"
              variant="ghost"
              onClick={() => openPreview?.({ src, name: attachment.name })}
              disabled={openPreview === null}
              className="inline-flex size-10 items-center justify-center overflow-hidden rounded-md border border-input bg-background p-0 hover:bg-background focus-visible:ring-2"
              title={attachment.name}
              aria-label={attachment.name}
              data-attachment-kind="image"
            >
              <img
                src={src}
                alt={attachment.name}
                className="h-full w-full object-cover"
                draggable={false}
              />
            </Button>
          );
        }
        if (attachment.kind === 'blob') {
          return (
            <span
              key={key}
              className="composer-mention-chip"
              title={attachment.name}
              data-attachment-kind="blob"
            >
              <span className="composer-mention-label">{attachment.name}</span>
            </span>
          );
        }
        return (
          <span
            key={key}
            className="composer-mention-chip"
            title={attachment.path}
            data-attachment-kind={attachment.kind}
          >
            <span className="composer-mention-label">@{attachment.name || attachment.path}</span>
          </span>
        );
      })}
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
        <Spinner
          className="size-3.5 text-muted-foreground"
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
              <Spinner className="size-3" aria-hidden="true" />
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
      ) : allowOptions.length > 1 || denyOptions.length > 1 ? (
        // Any escalating grant or extra refusal option; the one-row branch
        // renders only the primary of each stance, so a 2-allow / 0-reject
        // (or 0-allow / 2-reject) shape would otherwise silently drop its
        // second option. Stack every option as a full-width button — no
        // dropdown, no truncation, every choice legible. Primary allow up
        // top for affirmative-first read order (matches iOS action-sheet
        // convention), deny cluster below muted with a hairline divider
        // when both stances are present so the two groups read distinct.
        <div className="flex flex-col gap-1" data-testid="agent-thread-permission-stack">
          {(primaryAllow !== undefined ? [primaryAllow, ...secondaryAllows] : allowOptions).map(
            (option) => {
              const isPrimary = option === primaryAllow;
              return (
                <Button
                  key={option.optionId}
                  ref={isPrimary ? primaryRef : undefined}
                  type="button"
                  size="sm"
                  variant={isPrimary ? 'default' : 'outline'}
                  className="h-auto w-full justify-start whitespace-normal py-1.5 text-left text-xs normal-case font-sans"
                  onClick={() => selectOption(option.optionId)}
                  data-testid={isPrimary ? 'agent-thread-permission-allow' : undefined}
                  data-permission-kind={option.kind}
                >
                  {option.name}
                </Button>
              );
            },
          )}
          <div
            className={cn(
              'flex flex-col gap-1',
              // Only draw the group divider when the stack has both stances;
              // a refusal-only stack doesn't need an orphan hairline.
              allowOptions.length > 0 && 'mt-1.5 border-border/40 border-t pt-1.5',
            )}
          >
            {denyOptions.length > 0 ? (
              denyOptions.map((option, index) => (
                <Button
                  key={option.optionId}
                  ref={index === 0 ? focusRefForDeny : undefined}
                  type="button"
                  size="sm"
                  variant={index === 0 ? 'outline' : 'ghost'}
                  className="h-auto w-full justify-start whitespace-normal py-1.5 text-left text-xs normal-case font-sans text-muted-foreground hover:text-foreground"
                  onClick={() => selectOption(option.optionId)}
                  data-testid={index === 0 ? 'agent-thread-permission-deny' : undefined}
                  data-permission-kind={option.kind}
                >
                  {option.name}
                </Button>
              ))
            ) : (
              // Mirrors the row branch fallback — `cancelled` is the
              // protocol's only refusal when the agent offered no reject
              // option, so `no` exists at all even in a multi-allow stack.
              <Button
                ref={focusRefForDeny}
                type="button"
                size="sm"
                variant="outline"
                className="h-auto w-full justify-start whitespace-normal py-1.5 text-left text-xs normal-case font-sans text-muted-foreground hover:text-foreground"
                onClick={() =>
                  client.respondPermission(threadId, item.requestId, { kind: 'cancelled' })
                }
                data-testid="agent-thread-permission-deny"
              >
                {t`Deny`}
              </Button>
            )}
          </div>
        </div>
      ) : (
        // One-or-two options fit a single row without wrap: keep the classic
        // "refusal left, grant right" layout so the common Yes/No case reads
        // like every other confirm dialog.
        <div className="flex flex-wrap items-center justify-between gap-2">
          {denyOptions.length > 0 ? (
            (() => {
              // Row branch only reaches here when the stack gate falls through
              // (both counts <= 1); denyOptions[0] is the single reject.
              const only = denyOptions[0];
              return (
                <Button
                  ref={focusRefForDeny}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="text-xs normal-case font-sans"
                  title={only.name}
                  onClick={() => selectOption(only.optionId)}
                  data-testid="agent-thread-permission-deny"
                  data-permission-kind={only.kind}
                >
                  <span className="truncate max-w-64">{only.name}</span>
                </Button>
              );
            })()
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
              <span className="truncate max-w-64">{primaryAllow.name}</span>
            </Button>
          ) : null}
        </div>
      )}
    </div>
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
  const downloadLabelId = useId();

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
          <Spinner className="size-3.5 shrink-0" aria-hidden="true" />
          <span id={downloadLabelId}>{t`Downloading ${item.displayName} ${item.version}…`}</span>
        </div>
        {/* Naming the bar off the visible status line keeps one string doing
            both jobs. A download with no total bytes has no honest percentage,
            so it stays indeterminate and only the fill is faked. */}
        <Progress
          value={pct}
          indeterminateFillPercent={40}
          aria-labelledby={downloadLabelId}
          className="h-1.5"
        />
        {pct !== null ? (
          // The bar already carries this number as aria-valuenow; leaving the
          // text in the a11y tree would announce it twice.
          <div
            aria-hidden="true"
            className="mt-1 text-[11px] text-muted-foreground"
          >{`${pct}%`}</div>
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
        <span>
          {item.reason === 'damaged'
            ? t`${item.displayName} needs replacing`
            : t`${item.agentName} needs ${item.displayName}`}
        </span>
      </div>
      <p className="mb-2 text-muted-foreground text-xs">
        {item.reason === 'damaged'
          ? // This copy is OK's own, so the user has nothing to repair and no
            // reason to hear about their system interpreter.
            t`Open Knowledge's own copy of ${item.displayName} is damaged and won't run. It can download a fresh copy of ${item.displayName} ${item.version} (about ${item.approxSizeMB} MB from ${item.sourceHost}) to replace it.`
          : item.reason === 'broken'
            ? // Telling someone whose interpreter is present-but-broken that it
              // "isn't installed" sends them to install a second copy the broken
              // one still shadows on PATH.
              t`This agent runs through ${item.provides}, which is installed but won't run — its ${item.displayName} looks broken. Open Knowledge can download a private copy of ${item.displayName} ${item.version} (about ${item.approxSizeMB} MB from ${item.sourceHost}) that won't touch the rest of your system.`
            : t`This agent runs through ${item.provides}, which isn't installed. Open Knowledge can download a private copy of ${item.displayName} ${item.version} (about ${item.approxSizeMB} MB from ${item.sourceHost}) that won't touch the rest of your system.`}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          onClick={() =>
            client.respondRuntimeConsent(threadId, item.requestId, { kind: 'granted' })
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
            client.respondRuntimeConsent(threadId, item.requestId, { kind: 'declined' })
          }
          data-testid="agent-thread-runtime-consent-decline"
        >
          {t`Not now`}
        </Button>
      </div>
    </div>
  );
}

/**
 * How a Pi bridge attempt settled. Each state names a different fix, so none
 * of them share copy.
 */
function PiBridgeOutcomeRow({
  outcome,
  bridgePath,
}: {
  outcome: NonNullable<Extract<RenderedItem, { kind: 'pi_bridge' }>['outcome']>;
  bridgePath: string;
}): ReactNode {
  const { t } = useLingui();
  const ready = outcome.state === 'ready';
  return (
    <div
      className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-muted-foreground text-xs"
      data-testid="agent-thread-pi-bridge"
    >
      <div className="flex items-start gap-1.5">
        {ready ? (
          <Check
            className="mt-px size-3.5 shrink-0 text-green-600 dark:text-green-400"
            aria-hidden="true"
          />
        ) : null}
        <span>
          {outcome.state === 'ready'
            ? t`Open Knowledge tools are available in this thread.`
            : outcome.state === 'foreign-file'
              ? t`Open Knowledge tools are unavailable: a file Open Knowledge didn't write is already at ${bridgePath}.`
              : outcome.state === 'unreadable-file'
                ? t`Open Knowledge tools are unavailable: something is already at ${bridgePath} but couldn't be read, so Open Knowledge left it alone.`
                : outcome.state === 'trust-failed'
                  ? // The bridge is on disk but pi won't read it, so saying
                    // "couldn't write it" would send the user to the wrong half.
                    t`Wrote the Open Knowledge extension, but couldn't mark the folder trusted, so it won't load. This thread has no Open Knowledge tools.`
                  : t`Couldn't write the Open Knowledge extension. This thread has no Open Knowledge tools.`}
        </span>
      </div>
      {outcome.detail !== null ? (
        <div className="mt-1 break-all font-mono text-[11px] opacity-80">{outcome.detail}</div>
      ) : null}
    </div>
  );
}

/**
 * Prompt (and outcome) for provisioning Pi's bridge extension — the only way
 * OK's tools reach a Pi thread, since Pi has no MCP client. Same retained-item
 * shape as {@link RuntimeConsentPrompt}: it renders identically live and on
 * replay. The folder-trust disclosure is load-bearing copy, not a footnote —
 * approving lets Pi load every extension in that folder, not only OK's.
 */
function PiBridgeConsentPrompt({
  item,
  threadId,
}: {
  item: Extract<RenderedItem, { kind: 'pi_bridge' }>;
  threadId: string;
}): ReactNode {
  const { t } = useLingui();
  const client = getAgentThreadClient();

  // A notice is an outcome nobody was asked about; a prompted row that already
  // has one is done being a prompt. Splitting on the tag first is what lets the
  // rest of this function treat `item.prompt` as present.
  if (item.row === 'notice') {
    return <PiBridgeOutcomeRow outcome={item.outcome} bridgePath={item.bridgePath} />;
  }
  if (item.outcome !== null) {
    return <PiBridgeOutcomeRow outcome={item.outcome} bridgePath={item.bridgePath} />;
  }

  if (item.decision === 'declined' || item.decision === 'timeout') {
    return (
      <div
        className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-muted-foreground text-xs"
        data-testid="agent-thread-pi-bridge"
      >
        {item.decision === 'declined'
          ? t`Skipped enabling Open Knowledge tools. This thread runs without them.`
          : t`The request to enable Open Knowledge tools timed out. This thread runs without them.`}
      </div>
    );
  }

  if (item.decision === 'granted') {
    return (
      <div
        className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-muted-foreground text-xs"
        data-testid="agent-thread-pi-bridge"
      >
        <Spinner className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{t`Enabling Open Knowledge tools`}</span>
      </div>
    );
  }

  const prompt = item.prompt;
  const otherExtensions = prompt.otherExtensions.join(', ');
  return (
    <div
      className="rounded-md border border-blue-500/40 bg-blue-500/5 px-2.5 py-2 text-sm"
      data-testid="agent-thread-pi-bridge"
    >
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <Wrench className="size-4 shrink-0" aria-hidden="true" />
        <span>{t`Enable Open Knowledge tools for ${prompt.agentName}?`}</span>
      </div>
      <p className="mb-1.5 text-muted-foreground text-xs">
        {t`${prompt.agentName} has no way to read or edit your documents on its own. Approving writes the Open Knowledge extension to ${item.bridgePath} and leaves it there, so this session and later ones in this project have the Open Knowledge tools.`}
      </p>
      <p className="mb-2 text-muted-foreground text-xs">
        {t`It also marks ${prompt.cwd} as trusted, which is what makes the extension load. That trust covers the whole folder — ${prompt.agentName} will load every extension in it, not only Open Knowledge's — and both stay until you remove Open Knowledge from this project.`}
      </p>
      {otherExtensions !== '' ? (
        <p className="mb-2 text-muted-foreground text-xs">
          {t`That folder already holds code Open Knowledge didn't write, which the same trust would let ${prompt.agentName} run: ${otherExtensions}.`}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          onClick={() =>
            client.respondPiBridgeConsent(threadId, prompt.requestId, { kind: 'granted' })
          }
          data-testid="agent-thread-pi-bridge-allow"
        >
          {t`Approve`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() =>
            client.respondPiBridgeConsent(threadId, prompt.requestId, { kind: 'declined' })
          }
          data-testid="agent-thread-pi-bridge-decline"
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
  composerRef,
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
  selectedCommentCount,
  selectedCommentDocs,
  hasQueuedComments,
  onAttachComments,
  onDismissComments,
  pendingAttachments,
  pendingUploads,
  imagesAccepted,
  onIngestImageFiles,
  onIngestAllFiles,
  onRemovePendingAttachment,
}: {
  info: ThreadInfo;
  /** The parent's handle to the shared composer input — ThreadView reads the
   *  draft through it at send time and seeds it (staged passages, a cancelled
   *  turn's rescued queue) via `appendText`. */
  composerRef: RefObject<ComposerMentionInputHandle | null>;
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
  /** How many comments are ticked in the panel — what this send would carry. */
  selectedCommentCount: number;
  selectedCommentDocs: readonly CommentDocTally[];
  /**
   * Ticked AND still on this message. `BottomComposer` derives the same flag the
   * same way; the chip renders on the ticked count alone, since detached it is
   * the way back.
   */
  hasQueuedComments: boolean;
  onAttachComments: () => void;
  onDismissComments: () => void;
  /** Files/images the user dropped, pasted, or picked; parent owns the array. */
  pendingAttachments: readonly AttachmentPart[];
  /** Encoding-in-flight placeholders. */
  pendingUploads: readonly {
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
  }[];
  /** False iff the agent's `promptCapabilities.image` was explicitly `false`. */
  imagesAccepted: boolean;
  /** Image-only ingest for the paste path — refused when the agent doesn't
   *  accept images (drop uses `onIngestAllFiles` and takes anything). */
  onIngestImageFiles: (files: readonly File[]) => Promise<void>;
  /** Ingest ANY file (image or blob) — the drop-zone + `+` picker path. */
  onIngestAllFiles: (files: readonly File[]) => Promise<void>;
  onRemovePendingAttachment: (index: number) => void;
}): ReactNode {
  const { t } = useLingui();
  // Naming the agent in the placeholder ("Message Claude") beats a generic
  // "Message the agent"; strip the "Agent" suffix so it reads as the brand.
  const agentName = agentDisplayName(info.agent.name);

  // The input owns the draft; this host tracks only emptiness (pushed up via
  // `onEmptyChange`) to drive the send-enabled state and the Stop/Send/Steer
  // action slot. Content is read at send time through `composerRef`.
  const [isEmpty, setIsEmpty] = useState(true);

  // Typable in every live state, including the ones that are only waiting on
  // something: signing in takes a detour through a browser (and flips the
  // status to `installing` while it does), a failed start is a Retry away from
  // running, and a draft written across any of that must survive. Only a
  // thread whose agent is gone for good has nothing left to say. Sending is
  // still gated by canPrompt / canQueue.
  const composerDisabled = archived ? resumePending : status === 'exited';

  const usagePercent =
    usage !== null && usage.used !== undefined && usage.size !== undefined && usage.size > 0
      ? Math.min(100, Math.round((usage.used / usage.size) * 100))
      : null;

  const queue = info.queue ?? [];

  // What the action slot keys off. Both the Stop/Send choice and Send's disabled
  // state read this, or the two disagree. An attached batch counts as content:
  // the comments are the ask, so a send with nothing typed is a real send.
  const hasSendableContent = !isEmpty || hasQueuedComments || pendingAttachments.length > 0;

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
      {/* Two-row field: the input fills the full width on top; a bottom bar
          holds the model/agent settings (left) and the context ring + send/stop
          (right). The wrapper owns the border + focus ring so the whole box lights
          up on focus. Every control is a real in-flow sibling (natural Tab order,
          own focus ring) and the send button lives on its own row, so there's no
          reserved text gutter narrowing the input on multi-line drafts. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only affordance — pressing the card's whitespace focuses the composer input; keyboard/AT users reach it via Tab. See focus-composer-on-card-pointer.ts. */}
      <div
        onMouseDown={(event) => focusComposerInputOnCardPointer(event, composerRef)}
        onPaste={(event) => {
          // Paste is composer-focus-local (the outer drop-zone can't catch it
          // without stealing paste from every other focusable element on the
          // panel), so it lives here. Image-only guard mirrors the drop path
          // for images; a non-image clipboard content passes through to the
          // input's own paste handling.
          const files = collectImageFiles(event.clipboardData);
          if (files.length === 0) return;
          event.preventDefault();
          if (!imagesAccepted) {
            toast.error(t`${agentName} doesn't accept image attachments.`);
            return;
          }
          void onIngestImageFiles(files);
        }}
        className="relative cursor-text rounded-lg border border-input bg-transparent transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30"
      >
        {/* Queued comments as a context chip above the field, the same control
            the Ask AI composer carries — a count of what the panel has ticked
            plus the ✕ that unticks it. Same component in both composers, so the
            two read as one chip system. */}
        {/* Gated here as well as inside the chip: `ComposerContextChips` decides
            whether to render its row by counting children, and an element that
            returns null still counts as one. An empty batch has to contribute NO
            child, or the row appears as an empty strip above the field. */}
        {selectedCommentCount > 0 ? (
          <ComposerContextChips className="px-3 pt-2 pb-1">
            <QueuedCommentsChip
              count={selectedCommentCount}
              docs={selectedCommentDocs}
              attached={hasQueuedComments}
              onAttach={onAttachComments}
              onDismiss={onDismissComments}
            />
          </ComposerContextChips>
        ) : null}
        {pendingAttachments.length > 0 || pendingUploads.length > 0 ? (
          <PendingImageStrip
            images={pendingAttachments}
            uploads={pendingUploads}
            onRemove={onRemovePendingAttachment}
          />
        ) : null}
        <ComposerMentionInput
          ref={composerRef}
          // Stable accessible name — the placeholder is situational (and a
          // placeholder alone isn't a reliable label for screen readers).
          ariaLabel={t`Message ${agentName}`}
          onEmptyChange={setIsEmpty}
          // Enter with the `@`-popup closed (IME-composition guarded inside the
          // shared input, so a CJK commit-Enter never sends).
          onSubmit={onSubmit}
          onEscape={() => {
            // Deliberately field-scoped, not panel-wide. Sendable content hides
            // Stop, so Escape is the cancel path while composing — but Escape
            // is a dismiss-shaped key, and binding it panel-wide would let a
            // stray press kill a running turn with no undo. The accepted cost:
            // leave content in the composer, click away, and neither Stop nor
            // Escape is reachable until you click back or clear it. Judged rare
            // enough to accept over a broader binding or a second Stop. With no
            // turn running Escape is a no-op (never a blur), matching the
            // textarea this field replaced.
            if (turnActive && !cancelPending) onCancel();
          }}
          placeholder={
            archived
              ? resumePending
                ? t`Resuming the chat`
                : t`Pick up where you left off`
              : status === 'auth_required'
                ? t`Sign in to ${agentName} first`
                : status === 'authenticating'
                  ? t`Signing in to ${agentName}`
                  : t`Message ${agentName}`
          }
          disabled={composerDisabled}
          // The advertised slash-command corpus: null until the agent's
          // `available_commands_update` arrives, then the live list. Passing it
          // (vs omitting) is what mounts the `/` autocomplete — only this
          // surface dispatches to an agent that can execute commands.
          slashCommands={info.availableCommands ?? null}
          // The wrapper alone renders the field chrome and focus ring; this is a
          // bare scrolling text region sized to the old textarea (single slim
          // line at rest, capped growth). Full width — the action bar sits on
          // its own row below, so no right-padding gutter is reserved. Disabled
          // dims like the native textarea it replaced.
          className={cn(
            'max-h-40 overflow-y-auto px-2.5 pt-1 text-base md:text-sm',
            composerDisabled && 'opacity-50',
          )}
          testId="agent-thread-composer"
        />
        {/* Action bar: model/agent settings on the left, context ring + send/stop
            on the right. The send cluster uses `ml-auto` (not the row's
            justify-between) so it stays hard-right independent of what the
            settings popover renders (it stays mounted even for agents with no
            options, showing a disabled trigger instead of vanishing). */}
        <div className="flex items-center gap-2 px-1.5 pt-1 pb-1.5">
          <AgentSettingsPopover info={info} />
          <AttachFilesButton
            onFiles={onIngestAllFiles}
            referencesOnly={
              // Null/undefined means the handshake has not advertised capabilities
              // yet, not that it declined embedding. Avoid a transient restrictive
              // claim in the tooltip while that capability is still unknown.
              info.promptCapabilities !== null &&
              info.promptCapabilities !== undefined &&
              info.promptCapabilities.embeddedContext !== true
            }
          />
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
                      <Spinner className="size-3.5" aria-hidden="true" />
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
                {!isEmpty ? (
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

/** Derive the short chip label from a filename or mime (`report.pdf` → `pdf`,
 *  `image/png` → `png`). Falls back to `file` when neither carries a hint. */
function extensionLabel(name: string, mimeType: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
  const slash = mimeType.lastIndexOf('/');
  if (slash > 0 && slash < mimeType.length - 1) return mimeType.slice(slash + 1).toLowerCase();
  return 'file';
}

/**
 * Preview row for pending image attachments — thumbnails rendered from the
 * base64 payload, each with a remove control. Sits above the composer text
 * area (mirroring `ComposerContextChips`'s placement) and shares its `px-3
 * pt-2 pb-1` gutter so the two chip systems read as one.
 */
function PendingImageStrip({
  images,
  uploads,
  onRemove,
}: {
  images: readonly AttachmentPart[];
  uploads: readonly { readonly id: string; readonly name: string; readonly mimeType: string }[];
  onRemove: (index: number) => void;
}): ReactNode {
  const { t } = useLingui();
  const openPreview = use(ImagePreviewContext);
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2 pb-1" data-testid="agent-thread-pending-images">
      {images.map((image, index) => {
        // Per-kind identity + label: `image`/`blob` carry base64 data,
        // `file`/`folder` a workspace path. None of those is unique on its
        // own — attaching one picture twice (deliberately, or via a host that
        // hands the same payload back twice) yields two parts with identical
        // name and identical leading base64. Index disambiguates: this list is
        // append-ordered and `onRemove` already treats the index as the tile's
        // identity, so the two agree.
        const key =
          image.kind === 'image' || image.kind === 'blob'
            ? `${index}:${image.name}:${image.data.slice(0, 24)}`
            : `${index}:${image.name}:${image.path}`;
        const src = image.kind === 'image' ? `data:${image.mimeType};base64,${image.data}` : null;
        const label =
          image.kind === 'file' || image.kind === 'folder'
            ? extensionLabel(image.name, '')
            : extensionLabel(image.name, image.mimeType);
        return (
          // Two sibling buttons instead of nested — nesting <button> in
          // <button> is invalid HTML. The preview button fills the whole
          // tile; the remove button sits on top absolutely and its click
          // stops bubbling so the preview doesn't also open.
          <div key={key} className="group relative inline-flex size-14" title={image.name}>
            {src !== null ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => openPreview?.({ src, name: image.name })}
                disabled={openPreview === null}
                className="size-full items-center justify-center overflow-hidden rounded-md border border-input bg-muted p-0 hover:bg-muted"
                aria-label={image.name}
                data-testid="agent-thread-pending-image-preview"
              >
                <img
                  src={src}
                  alt={image.name}
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              </Button>
            ) : (
              <div className="inline-flex size-full items-center justify-center overflow-hidden rounded-md border border-input bg-muted">
                <span className="text-muted-foreground text-xs uppercase">{label}</span>
              </div>
            )}
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={(event) => {
                event.stopPropagation();
                onRemove(index);
              }}
              aria-label={t`Remove ${image.name}`}
              className="absolute top-0.5 right-0.5 size-5 rounded-full border border-border bg-background/80 p-0 shadow-sm opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              data-testid="agent-thread-pending-image-remove"
            >
              <X className="size-3" aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      {uploads.map((upload) => (
        <div
          key={upload.id}
          className="relative inline-flex size-14 items-center justify-center overflow-hidden rounded-md border border-input bg-muted"
          title={upload.name}
          data-testid="agent-thread-pending-upload"
        >
          <Spinner className="size-4 text-muted-foreground" aria-hidden="true" />
        </div>
      ))}
    </div>
  );
}

/**
 * Panel-wide dashed drop-zone overlay — shown whenever a file drag is over
 * the whole chat panel. Accepts any file (image → ImageContent, everything
 * else → EmbeddedResource); per-file rejection surfaces as a toast after
 * drop rather than gating the overlay. `onDismiss` fires on a click so the
 * user can escape a stuck overlay without a second drop.
 */
function ChatPanelDropOverlay({ onDismiss }: { onDismiss: () => void }): ReactNode {
  const { t } = useLingui();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: transient drop overlay — keyboard/AT users never see it (drag-only surface), and click-to-dismiss is a safety escape for a stuck overlay.
    // biome-ignore lint/a11y/useKeyWithClickEvents: same reason — the overlay is drag-only, never keyboard-reachable, so a keyboard handler would be dead code.
    <div
      className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center bg-background/85 backdrop-blur-sm"
      onClick={onDismiss}
      data-testid="agent-thread-drop-overlay"
    >
      <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-primary/70 border-dashed bg-background/90 px-8 py-6 text-center text-primary shadow-lg">
        <Plus className="size-8" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <span className="font-medium text-base">{t`Drop a file to attach`}</span>
          <span className="text-muted-foreground text-xs">
            {t`Images from anywhere · non-image files must be in the workspace`}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * OS file-picker trigger for the composer action bar — the keyboard-and-AT
 * counterpart to drag-and-drop. A `+` icon button opens the picker via an
 * imperatively-created `<input type="file" multiple>`; picked files ride
 * the same `onIngestAllFiles` path drops use, so validation + toasts +
 * preview all behave identically. Imperative creation keeps the raw DOM
 * primitive out of the JSX tree — the shadcn-first UI-primitives rule bans
 * raw `<input>` in packages/app tsx files, and shadcn's `Input` is a
 * styled text field, not a file trigger.
 */
function AttachFilesButton({
  onFiles,
  referencesOnly,
}: {
  onFiles: (files: readonly File[]) => Promise<void>;
  referencesOnly: boolean;
}): ReactNode {
  const { t } = useLingui();
  const openFilePicker = () => {
    // Detached element — `HTMLInputElement.click()` opens the OS picker on
    // an element with no parent, so a cancelled picker leaves nothing to
    // remove from the DOM. The input holds only its own listeners; once
    // no reference survives this closure, the GC collects it.
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (files.length > 0) void onFiles(files);
    });
    input.click();
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="rounded-lg"
          onClick={openFilePicker}
          aria-label={t`Attach a file`}
          data-testid="agent-thread-attach-files"
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {t`Attach a file`}
        {referencesOnly ? t` · references only (no embedded contents)` : null}
      </TooltipContent>
    </Tooltip>
  );
}
