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

const CANCEL_STALL_MS = 10_000;

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

function agentDisplayName(name: string): string {
  return name.replace(/\s+Agent$/i, '');
}

type ImagePreview = { readonly src: string; readonly name: string };

const ImagePreviewContext = createContext<((preview: ImagePreview) => void) | null>(null);

const RETRYABLE_FAILURE_REASONS: ReadonlySet<ThreadFailureDetail['reason']> = new Set([
  'connect',
  'session-setup',
  'auth-required',
]);

function isRetryableFailure(failure: ThreadFailureDetail): boolean {
  return RETRYABLE_FAILURE_REASONS.has(failure.reason);
}

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
  active?: boolean;
}): ReactNode {
  const { t } = useLingui();
  const state = useAgentThread(info.threadId);
  const client = getAgentThreadClient();
  const workspace = useWorkspace();
  const composerRef = useRef<ComposerMentionInputHandle>(null);
  const [pendingAttachments, setPendingAttachments] = useState<readonly AttachmentPart[]>([]);
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const openImagePreview = (preview: ImagePreview) => setImagePreview(preview);
  const [pendingUploads, setPendingUploads] = useState<
    readonly { readonly id: string; readonly name: string; readonly mimeType: string }[]
  >([]);
  const [dragActive, setDragActive] = useState(false);
  const [dropNotice, setDropNotice] = useState<{ text: string; id: number } | null>(null);
  const dropNoticeIdRef = useRef(0);
  useEffect(() => {
    if (dropNotice === null) return;
    const timer = setTimeout(() => setDropNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [dropNotice]);
  const imagesAccepted = info.promptCapabilities?.image === true;
  const composerText = (): string => composerRef.current?.getContent().instruction.trim() ?? '';
  const composerAttachments = (): readonly AttachmentPart[] => {
    const chips = composerRef.current?.getContent().attachments ?? [];
    return [...chips, ...pendingAttachments];
  };
  const ingestFiles = async (files: readonly File[]): Promise<void> => {
    const absPathOf =
      typeof window !== 'undefined' && window.okDesktop
        ? window.okDesktop.getPathForFile
        : undefined;
    const workspaceContentDir = workspace?.contentDir;
    const pathSeparator = workspace?.pathSeparator;
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
  const scrollApiRef = useRef<ReturnType<typeof useMessageScroller> | null>(null);
  const initialSeqRef = useRef<number | null>(null);
  const followNavRef = useRef<FollowNavState>(INITIAL_FOLLOW_NAV_STATE);
  const prevTurnActiveRef = useRef(false);

  useEffect(() => {
    return subscribeStagedThreadDraft(info.threadId, (text) => {
      composerRef.current?.appendText(text);
    });
  }, [info.threadId]);

  const model = useAgentThreadModel(info.threadId);
  const status = info.status;
  const archived = info.archived === true;
  const turnActive = model?.turnActive === true && !archived;
  const thinkingLine = useThinkingLine(turnActive);
  const [resumePending, setResumePending] = useState(false);
  const [resumeError, setResumeError] = useState<ThreadResumeError | null>(null);
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
  const signingIn = status === 'authenticating';
  const awaitingSignIn = status === 'auth_required' || signingIn;
  const canRetry = !archived && (status === 'error' || awaitingSignIn);
  const [retryPending, setRetryPending] = useState(false);
  const [revertedPositions, setRevertedPositions] = useState<ReadonlySet<number>>(new Set());
  const canQueue = !archived && turnActive;
  const pageList = useOptionalPageList();
  const pages =
    pageList !== null && !pageList.loading && pageList.pages.size > 0 ? pageList.pages : null;
  const docPathResolver = pages === null ? null : buildDocPathResolver({ workspace, pages });
  setDocPathResolver(docPathResolver);
  const resolverReady = docPathResolver !== null;
  const transcriptFollowTarget = model !== null ? latestFollowTarget(model.items, workspace) : null;

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

  const followTarget =
    transcriptFollowTarget ??
    (presenceWrites.length > 0 ? (presenceWrites[presenceWrites.length - 1]?.doc ?? null) : null);
  const lastSeq = state?.lastSeq ?? null;
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelStalled, setCancelStalled] = useState(false);
  const [planApprovalPending, setPlanApprovalPending] = useState(false);

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

  useEffect(() => {
    if (!canRetry) setRetryPending(false);
  }, [canRetry]);

  useEffect(() => {
    if (turnActive && !prevTurnActiveRef.current) {
      followNavRef.current = { ...followNavRef.current, yielded: false, reArmed: true };
    }
    prevTurnActiveRef.current = turnActive;
  }, [turnActive]);

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
    if (next) {
      followNavRef.current = INITIAL_FOLLOW_NAV_STATE;
    }
  };

  const [failedPrompt, setFailedPrompt] = useState<string | null>(null);

  const selectedCommentCount = useSelectedCommentCount();
  const selectedCommentDocs = useSelectedCommentDocs();
  const [commentsAttached, setCommentsAttached] = useState(true);
  const hasQueuedComments = selectedCommentCount > 0 && commentsAttached;
  useEffect(() => subscribeCommentPosted(() => setCommentsAttached(true)), []);

  const sendText = (
    text: string,
    failureText: string | null = text,
    attachments: readonly AttachmentPart[] = [],
  ): Promise<boolean> => {
    const parts = attachments.length > 0 ? attachments : undefined;
    if (!archived) {
      client.prompt(info.threadId, text, parts);
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

  const resendMessage = async (
    text: string,
    target: ResendTarget,
    attachments: readonly AttachmentPart[],
  ): Promise<boolean> => {
    if (target.kind === 'this-thread') {
      return sendText(text, null, attachments);
    }
    const outcome = await launchAgentThread(
      { source: target.agent.source, id: target.agent.id },
      text,
      null,
      null,
      null,
      attachments,
    );
    if (outcome === 'deduped') {
      toast.error(t`Already starting a chat with this agent — try again in a moment.`);
    }
    return outcome === 'started';
  };

  const submit = (): void => {
    const text = composerText();
    const attachments = composerAttachments();
    if (!(canPrompt || canQueue)) return;
    if (hasQueuedComments) {
      submitQueuedComments(text).catch((err) => {
        console.warn('[acp] queued-comment send rejected unexpectedly', err);
      });
      return;
    }
    if (text === '' && attachments.length === 0) return;
    void sendText(text, text, attachments);
    composerRef.current?.clear();
    setPendingAttachments([]);
    setPendingUploads([]);
  };

  const submitQueuedComments = async (
    instruction: string,
    threadIds?: readonly string[],
  ): Promise<void> => {
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
    setCommentsAttached(true);
  };

  const sendCommentsFromPanel = useEffectEvent((threadIds?: readonly string[]) => {
    if (!(canPrompt || canQueue)) return;
    submitQueuedComments(composerText(), threadIds).catch((err) => {
      console.warn('[acp] panel comment send rejected unexpectedly', err);
    });
  });

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
        setResumeError(
          err instanceof ThreadResumeError
            ? err
            : new ThreadResumeError('internal', err instanceof Error ? err.message : String(err)),
        );
        setFailedPrompt(prompt ?? null);
      });
  };

  const foldedEntries =
    model === null
      ? []
      : model.items.flatMap((item, modelIndex) =>
          item.kind !== 'notice' || item.superseded !== true ? [{ item, modelIndex }] : [],
        );
  const foldedItems = foldedEntries.map((entry) => entry.item);
  const visibleEntries = foldedEntries.filter((_, index) => !revertedPositions.has(index));
  const visibleItems = visibleEntries.map((entry) => entry.item);
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
  const mapVisibleToFolded = (target: number): number => {
    let seen = -1;
    for (let index = 0; index < foldedItems.length; index += 1) {
      if (revertedPositions.has(index)) continue;
      seen += 1;
      if (seen === target) return index;
    }
    return -1;
  };

  let lastUserTurnIndex = -1;
  for (let index = visibleItems.length - 1; index >= 0; index -= 1) {
    const item = visibleItems[index];
    if (item?.kind === 'message' && item.role === 'user') {
      lastUserTurnIndex = index;
      break;
    }
  }

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
          {}
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
                        void sendText('Approve. Please proceed with the plan.');
                      },
                      onAskChanges: () => {
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
            <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
              <ScrollToEndBridge apiRef={scrollApiRef} />
              <MessageScroller className="min-h-0 flex-1">
                <MessageScrollerViewport
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
                          className="flex flex-col"
                          scrollAnchor={item.kind === 'message' && item.role === 'user'}
                          data-tool-call={item.kind === 'tool_call' ? '' : undefined}
                        >
                          <ThreadItem
                            item={item}
                            threadId={info.threadId}
                            agent={info.agent}
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
                      <div
                        className="flex items-center gap-2 px-1 py-1 text-muted-foreground text-sm"
                        data-testid="agent-thread-starting"
                      >
                        <Spinner className="size-3.5" aria-hidden="true" />
                        {}
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

function PermissionPostureBadge({ info }: { info: ThreadInfo }): ReactNode {
  const { t } = useLingui();
  if (deriveAgentPosture(info.agent.id, info.modes) !== 'autonomous') return null;
  const label = t`${info.agent.name} acts without asking — OpenKnowledge can't add permission prompts for it`;
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

function flattenSelectValues(option: SelectConfigOption): Array<{ id: string; name: string }> {
  const flat: Array<{ id: string; name: string }> = [];
  for (const entry of option.options) {
    if ('value' in entry) flat.push({ id: entry.value, name: entry.name });
    else for (const grouped of entry.options) flat.push({ id: grouped.value, name: grouped.name });
  }
  return flat;
}

interface ModeSurface {
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

function AgentSettingsPopover({ info }: { info: ThreadInfo }): ReactNode {
  const { t } = useLingui();
  const reasonId = useId();
  const client = getAgentThreadClient();
  const settingsKey = agentSettingsKey(info.agent);
  const applyConfig = (option: SessionConfigOption, value: string | boolean): void => {
    client.setConfigOption(info.threadId, option.id, value);
    rememberAgentConfigOption(settingsKey, option.id, value);
  };
  const configOptions = (info.configOptions ?? []).filter(
    (option) => option.type === 'boolean' || hasSelectValues(option),
  );
  const modeSurface = deriveModeSurface(info);
  const showLegacyModes = modeSurface !== null && modeSurface.configId === null;
  if (configOptions.length === 0 && !showLegacyModes) {
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
          {}
          <span className="inline-flex cursor-not-allowed">
            <Button
              type="button"
              variant="ghost"
              className="h-6 max-w-48 gap-1 rounded-md pl-1.5 pr-1! text-xs"
              aria-label={t`Agent settings`}
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
              {}
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
      {}
      <DropdownMenuContent align="end" className="w-60" data-testid="agent-thread-settings-popover">
        {}
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
      {}
      <DropdownMenuSubContent className="max-h-[min(22rem,var(--radix-dropdown-menu-content-available-height))] max-w-72 overscroll-contain">
        {}
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
      {}
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{entry.name}</span>
        {entry.description ? (
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
  return (
    <DropdownMenuCheckboxItem
      checked={option.currentValue}
      onCheckedChange={onCheckedChange}
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

function ThreadTranscriptSkeleton(): ReactNode {
  const { t } = useLingui();
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

  if (archived) {
    return <ThreadTranscriptSkeleton />;
  }

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
  actionable: boolean;
  streaming: boolean;
  terminals: Record<string, RenderedTerminal>;
  permissionsByToolCall: Record<string, RenderedPermission>;
  showRetry: boolean;
  retryPending: boolean;
  onRetry: () => void;
  showRestore: boolean;
  onRestore: () => void;
  onResend: (
    text: string,
    target: ResendTarget,
    attachments: readonly AttachmentPart[],
  ) => Promise<boolean>;
  canSendHere: boolean;
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
        <div className="px-1 text-muted-foreground text-xs italic **:font-normal! **:text-xs!">
          <AgentMarkdown text={item.text} />
        </div>
      ) : null}
    </div>
  );
}

function SignInOutput({ output }: { output?: string[] }): ReactNode {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
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
      .catch(() => {});
  };

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
  signingIn: boolean;
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
      {}
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
              {}
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
  agent: ThreadInfo['agent'];
  onResend: (
    text: string,
    target: ResendTarget,
    attachments: readonly AttachmentPart[],
  ) => Promise<boolean>;
  canSendHere: boolean;
  isLatestUserTurn: boolean;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState(false);
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
      <div
        className="w-full wrap-break-word text-sm text-foreground"
        data-testid="agent-thread-agent-message"
      >
        {}
        <AgentMarkdown text={item.text} />
      </div>
    );
  }
  const attachments = item.attachments;
  return (
    <div
      className={cn(
        'group/user-message my-3 ml-auto flex flex-col',
        editing ? 'w-full' : 'max-w-[85%]',
      )}
    >
      <div
        className={cn(
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
              const session = editSession.current;
              if (!(await onResend(text, target, [...(attachments ?? []), ...chips]))) return;
              if (editSession.current !== session) return;
              closeEditor(target.kind === 'this-thread');
            }}
          />
        ) : (
          <>
            {}
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

function stripWrappingFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return text;
  const lines = trimmed.split('\n');
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
  permission?: RenderedPermission;
}): ReactNode {
  const [open, setOpen] = useState(call.status === 'failed');
  const userToggledRef = useRef(false);
  const prevStatusRef = useRef(call.status);
  const [completedLive, setCompletedLive] = useState(false);
  const [checkVisible, setCheckVisible] = useState(false);
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
      {}
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

function usePermissionOutcomeLabel(): (outcome: PermissionOutcome) => string | null {
  const { t } = useLingui();
  return (outcome) => {
    if (outcome === null) return null;
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
  if (status === 'failed') return null;
  return (
    <span className="shrink-0 text-muted-foreground" data-testid="agent-thread-tool-permission">
      {outcomeLabel(outcome)}
    </span>
  );
}

function ToolStatusIndicator({
  status,
  completedLive,
  checkVisible,
}: {
  status: RenderedToolCall['status'];
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

  const allowOptions = item.options.filter((option) => option.kind.startsWith('allow'));
  const rejectOptions = item.options.filter((option) => option.kind.startsWith('reject'));
  const primaryAllow = allowOptions.find((o) => o.kind === 'allow_once') ?? allowOptions[0];
  const secondaryAllows = allowOptions.filter((option) => option !== primaryAllow);
  const primaryReject = rejectOptions.find((o) => o.kind === 'reject_once') ?? rejectOptions[0];
  const denyOptions =
    primaryReject === undefined
      ? []
      : [primaryReject, ...rejectOptions.filter((option) => option !== primaryReject)];
  const focusRefForDeny = primaryAllow === undefined ? primaryRef : undefined;

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
        <div className="text-muted-foreground text-xs">{t`This request is no longer active.`}</div>
      ) : allowOptions.length > 1 || denyOptions.length > 1 ? (
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          {denyOptions.length > 0 ? (
            (() => {
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
        {}
        <Progress
          value={pct}
          indeterminateFillPercent={40}
          aria-labelledby={downloadLabelId}
          className="h-1.5"
        />
        {pct !== null ? (
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
          ? t`Open Knowledge's own copy of ${item.displayName} is damaged and won't run. It can download a fresh copy of ${item.displayName} ${item.version} (about ${item.approxSizeMB} MB from ${item.sourceHost}) to replace it.`
          : item.reason === 'broken'
            ? t`This agent runs through ${item.provides}, which is installed but won't run — its ${item.displayName} looks broken. Open Knowledge can download a private copy of ${item.displayName} ${item.version} (about ${item.approxSizeMB} MB from ${item.sourceHost}) that won't touch the rest of your system.`
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
                  ? t`Wrote the Open Knowledge extension, but couldn't mark the folder trusted, so it won't load. This thread has no Open Knowledge tools.`
                  : t`Couldn't write the Open Knowledge extension. This thread has no Open Knowledge tools.`}
        </span>
      </div>
      {outcome.detail !== null ? (
        <div className="mt-1 break-all font-mono text-[11px] opacity-80">{outcome.detail}</div>
      ) : null}
    </div>
  );
}

function PiBridgeConsentPrompt({
  item,
  threadId,
}: {
  item: Extract<RenderedItem, { kind: 'pi_bridge' }>;
  threadId: string;
}): ReactNode {
  const { t } = useLingui();
  const client = getAgentThreadClient();

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

function formatCompactTokens(value: number): string {
  const thousands = Math.round(value / 1_000);
  if (thousands >= 1_000) {
    const millions = value / 1_000_000;
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${thousands}k`;
  return String(value);
}

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
        {}
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
  composerRef: RefObject<ComposerMentionInputHandle | null>;
  onSubmit: () => void;
  canPrompt: boolean;
  canQueue: boolean;
  turnActive: boolean;
  cancelPending: boolean;
  onCancel: () => void;
  onSteer: () => void;
  status: ThreadInfo['status'];
  archived: boolean;
  resumePending: boolean;
  usage: { used?: number; size?: number } | null;
  selectedCommentCount: number;
  selectedCommentDocs: readonly CommentDocTally[];
  hasQueuedComments: boolean;
  onAttachComments: () => void;
  onDismissComments: () => void;
  pendingAttachments: readonly AttachmentPart[];
  pendingUploads: readonly {
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
  }[];
  imagesAccepted: boolean;
  onIngestImageFiles: (files: readonly File[]) => Promise<void>;
  onIngestAllFiles: (files: readonly File[]) => Promise<void>;
  onRemovePendingAttachment: (index: number) => void;
}): ReactNode {
  const { t } = useLingui();
  const agentName = agentDisplayName(info.agent.name);

  const [isEmpty, setIsEmpty] = useState(true);

  const composerDisabled = archived ? resumePending : status === 'exited';

  const usagePercent =
    usage !== null && usage.used !== undefined && usage.size !== undefined && usage.size > 0
      ? Math.min(100, Math.round((usage.used / usage.size) * 100))
      : null;

  const queue = info.queue ?? [];

  const hasSendableContent = !isEmpty || hasQueuedComments || pendingAttachments.length > 0;

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
      {}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only affordance — pressing the card's whitespace focuses the composer input; keyboard/AT users reach it via Tab. See focus-composer-on-card-pointer.ts. */}
      <div
        onMouseDown={(event) => focusComposerInputOnCardPointer(event, composerRef)}
        onPaste={(event) => {
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
        {}
        {}
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
          ariaLabel={t`Message ${agentName}`}
          onEmptyChange={setIsEmpty}
          onSubmit={onSubmit}
          onEscape={() => {
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
          slashCommands={info.availableCommands ?? null}
          className={cn(
            'max-h-40 overflow-y-auto px-2.5 pt-1 text-base md:text-sm',
            composerDisabled && 'opacity-50',
          )}
          testId="agent-thread-composer"
        />
        {}
        <div className="flex items-center gap-2 px-1.5 pt-1 pb-1.5">
          <AgentSettingsPopover info={info} />
          <AttachFilesButton
            onFiles={onIngestAllFiles}
            referencesOnly={
              info.promptCapabilities !== null &&
              info.promptCapabilities !== undefined &&
              info.promptCapabilities.embeddedContext !== true
            }
          />
          <div className="ml-auto flex items-center gap-1.5">
            {usagePercent !== null && usage?.used !== undefined && usage?.size !== undefined ? (
              <ContextUsageRing used={usage.used} size={usage.size} percent={usagePercent} />
            ) : null}
            {}
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
                {}
                <TooltipContent side="top">{t`Stop (Esc)`}</TooltipContent>
              </Tooltip>
            ) : canQueue ? (
              <>
                {}
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
                  {}
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
      cancelEdit();
      return;
    }
    setEditing(false);
    if (trimmed === message.content) {
      release();
      return;
    }
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
          {}
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

function extensionLabel(name: string, mimeType: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
  const slash = mimeType.lastIndexOf('/');
  if (slash > 0 && slash < mimeType.length - 1) return mimeType.slice(slash + 1).toLowerCase();
  return 'file';
}

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

function AttachFilesButton({
  onFiles,
  referencesOnly,
}: {
  onFiles: (files: readonly File[]) => Promise<void>;
  referencesOnly: boolean;
}): ReactNode {
  const { t } = useLingui();
  const openFilePicker = () => {
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
