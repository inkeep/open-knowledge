/**
 * Renders one ACP agent thread: the message/tool-call transcript, the live
 * plan checklist, inline permission prompts, a mode picker, and the prompt
 * composer with cancel. UX reference: Zed's agent panel — a single scrolling
 * transcript of turns with tool calls shown as collapsible cards.
 *
 * All copy routes through Lingui; every interactive primitive is a shadcn
 * component (this subtree is NOT the ProseMirror-exempt editor tree).
 */

import type {
  SessionConfigOption,
  ThreadInfo,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { useLingui } from '@lingui/react/macro';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Download,
  FileText,
  Loader2,
  MousePointer2,
  Search,
  Sparkles,
  Square,
  SquarePen,
  Terminal as TerminalIcon,
  Trash2,
  Wrench,
} from 'lucide-react';
import {
  Fragment,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { focusComposerInputOnCardPointer } from '@/components/focus-composer-on-card-pointer';
import { useOptionalPageList } from '@/components/PageListContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDocumentContext } from '@/editor/DocumentContext';
import { computeDiffRows } from '@/lib/acp/inline-diff';
import { renderTerminalText } from '@/lib/acp/terminal-text';
import {
  getAgentThreadClient,
  ThreadResumeError,
  useAgentThread,
  useAgentThreadModel,
} from '@/lib/acp/thread-client';
import {
  type RenderedItem,
  type RenderedTerminal,
  type RenderedToolCall,
  resolvePermissionOutcome,
} from '@/lib/acp/thread-event-model';
import { docNameFromHash, hashFromDocName } from '@/lib/doc-hash';
import { useWorkspace } from '@/lib/use-workspace';
import { cn } from '@/lib/utils';
import { AgentMarkdown } from './AgentMarkdown';
import { latestFollowTarget, loadFollowFilePref, saveFollowFilePref } from './follow-file';
import { appendPresenceWrite, latestAgentWrite, type PresenceWrite } from './presence-follow';
import { RegisteredAgentIcon } from './RegisteredAgentIcon';

/**
 * Stop sends ACP `session/cancel` — a courtesy the agent may ignore while it
 * keeps generating (and billing). Past this window the view stops pretending
 * and offers the force-quit escape hatch.
 */
const CANCEL_STALL_MS = 10_000;

const TOOL_ICONS: Record<string, typeof Wrench> = {
  read: FileText,
  edit: SquarePen,
  delete: Trash2,
  search: Search,
  execute: TerminalIcon,
  fetch: Search,
  think: Sparkles,
};

/** Display name for an agent — drops a trailing "Agent" so it reads as the brand
 *  ("Claude Agent" → "Claude"). */
function agentDisplayName(name: string): string {
  return name.replace(/\s+Agent$/i, '');
}

export function ThreadView({ info }: { info: ThreadInfo }): ReactNode {
  const { t } = useLingui();
  const state = useAgentThread(info.threadId);
  const client = getAgentThreadClient();
  const workspace = useWorkspace();
  const [draft, setDraft] = useState('');
  const [followFile, setFollowFile] = useState(loadFollowFilePref);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // Follow-the-file bookkeeping: `initialSeqRef` marks the event log position
  // at mount so a replayed history (reload, tab switch) never yanks the
  // editor around — only events that arrive live do. `lastFollowedRef`
  // dedupes so each target navigates once.
  const initialSeqRef = useRef<number | null>(null);
  const lastFollowedRef = useRef<string | null>(null);

  // Incrementally folded in the store — never re-fold `state.events` here;
  // the per-render full fold was O(transcript) per streamed chunk.
  const model = useAgentThreadModel(info.threadId);
  const status = info.status;
  const archived = info.archived === true;
  // An archived transcript can end mid-turn (server crash while streaming) —
  // never let the fold's stale turn state drive the running UI.
  const turnActive = model?.turnActive === true && !archived;
  const [resumePending, setResumePending] = useState(false);
  const [resumeError, setResumeError] = useState<ThreadResumeError | null>(null);
  const canPrompt = archived ? !resumePending : status === 'ready' && !turnActive;
  // Command-derived follow targets (exec `cat foo.md`) only navigate to docs
  // that exist — a read of a missing file would open a blank create-on-open
  // tab. Skipped while the page list is still loading (unknown ≠ missing).
  // Optional variant: the dock renders in hosts/tests without the provider.
  const pageList = useOptionalPageList();
  const pages = pageList !== null && !pageList.loading ? pageList.pages : null;
  const followOptions =
    pages !== null ? { commandTargetExists: (docName: string) => pages.has(docName) } : {};
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
    client.cancel(info.threadId);
    setCancelPending(true);
  };

  useEffect(() => {
    if (lastSeq !== null && initialSeqRef.current === null) initialSeqRef.current = lastSeq;
  }, [lastSeq]);

  // Follow the agent's file: navigate the editor to the doc the agent is
  // working on, as it works. Live events only (see initialSeqRef above), and
  // only while a turn is streaming — an idle thread never steals navigation.
  useEffect(() => {
    if (!followFile || followTarget === null) return;
    if (!turnActive) return;
    if (initialSeqRef.current === null || lastSeq === null || lastSeq <= initialSeqRef.current) {
      return;
    }
    if (lastFollowedRef.current === followTarget) return;
    lastFollowedRef.current = followTarget;
    if (docNameFromHash(window.location.hash) === followTarget) return;
    window.location.assign(hashFromDocName(followTarget));
  }, [followFile, followTarget, turnActive, lastSeq]);

  const toggleFollow = (): void => {
    const next = !followFile;
    setFollowFile(next);
    saveFollowFilePref(next);
    // Re-arm on re-enable so the current target is navigated to immediately.
    if (next) {
      lastFollowedRef.current = null;
    }
  };

  // Keep the transcript pinned to the bottom while the user hasn't scrolled up.
  // `lastSeq` is the trigger (a new event landed), not a value read in the body,
  // so it reads as an "unnecessary" dep to the analyzer — but dropping it makes
  // auto-scroll stop firing on new output.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lastSeq is the render trigger for the scroll, not a body dependency
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [state?.lastSeq]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  // The last resume-carried message that failed — the "new thread" fallback
  // re-sends it there. Kept out of the draft: the server's optimistic echo
  // already shows it in the transcript, so putting it back in the composer
  // would read as two copies.
  const [failedPrompt, setFailedPrompt] = useState<string | null>(null);

  const submit = (): void => {
    const text = draft.trim();
    if (text === '' || !canPrompt) return;
    if (archived) {
      // Type-to-resume: the send respawns the agent and reconnects the
      // stored session; the message rides the resume op as its first turn
      // (the server echoes it into the transcript immediately).
      setResumePending(true);
      setResumeError(null);
      setFailedPrompt(null);
      client
        .resumeThread(info.threadId, text)
        .catch((err) => {
          setResumeError(
            err instanceof ThreadResumeError
              ? err
              : new ThreadResumeError('internal', err instanceof Error ? err.message : String(err)),
          );
          setFailedPrompt(text);
        })
        .finally(() => setResumePending(false));
      setDraft('');
      atBottomRef.current = true;
      return;
    }
    client.prompt(info.threadId, text);
    setDraft('');
    atBottomRef.current = true;
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

  return (
    <div
      className="flex min-h-0 flex-1 flex-col text-gray-800 dark:text-gray-200"
      data-agent-thread-root=""
    >
      <ThreadHeader info={info} followFile={followFile} onToggleFollow={toggleFollow} />
      {model !== null && model.plan.length > 0 ? <PlanChecklist plan={model.plan} /> : null}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 subtle-scrollbar scroll-fade-mask"
        data-testid="agent-thread-transcript"
      >
        {model === null || model.items.length === 0 ? (
          <ThreadEmptyState status={status} archived={archived} agent={info.agent} />
        ) : (
          <div className="flex flex-col gap-2">
            {model.items.map((item, index) => (
              <ThreadItem
                // biome-ignore lint/suspicious/noArrayIndexKey: transcript is append-only; index is stable
                key={index}
                item={item}
                threadId={info.threadId}
                // Thread liveness, not turn liveness: the server keeps an
                // unanswered request answerable until its timeout even after
                // the prompt settles (and some agents ask outside a turn) —
                // only a dead thread makes answering impossible.
                actionable={!archived && status !== 'exited' && status !== 'error'}
                terminals={model.terminals}
              />
            ))}
            {turnActive ? (
              status === 'awaiting_permission' ? (
                <div
                  className="flex items-center gap-2 px-1 py-1 text-amber-700 text-sm dark:text-amber-400"
                  data-testid="agent-thread-awaiting-permission"
                >
                  <CircleDot className="size-3.5" aria-hidden="true" />
                  <span>{t`Waiting for your approval`}</span>
                </div>
              ) : (
                <div
                  className="flex items-center gap-2 px-1 py-1 text-muted-foreground text-sm"
                  data-testid="agent-thread-working"
                >
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  <span>{t`Working…`}</span>
                </div>
              )
            ) : status === 'installing' || status === 'spawning' ? (
              // A resume respawning its agent: the optimistic message echo is
              // already in the transcript above — show that the agent is on
              // its way rather than a silent gap until the turn opens.
              <div
                className="flex items-center gap-2 px-1 py-1 text-muted-foreground text-sm"
                data-testid="agent-thread-starting"
              >
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                <span>{t`Starting the agent…`}</span>
              </div>
            ) : null}
          </div>
        )}
      </div>
      {cancelStalled && turnActive ? (
        <div
          className="flex items-center gap-2 border-amber-500/30 border-t bg-amber-500/5 px-3 py-1.5 text-amber-700 text-xs dark:text-amber-400"
          data-testid="agent-thread-cancel-stalled"
        >
          <span className="flex-1">
            {t`The agent isn't stopping. Force stop closes this thread and quits the agent.`}
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
              ? t`${info.agent.name} can't continue this conversation — the transcript is kept, but the agent session is gone.`
              : t`Couldn't resume this conversation: ${resumeError.message}`}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 shrink-0 text-xs"
            onClick={startFreshThread}
            data-testid="agent-thread-resume-fallback-new"
          >
            {t`New thread with ${info.agent.name}`}
          </Button>
        </div>
      ) : null}
      <ThreadComposer
        info={info}
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={submit}
        canPrompt={canPrompt}
        turnActive={turnActive}
        cancelPending={cancelPending}
        onCancel={requestCancel}
        status={status}
        archived={archived}
        resumePending={resumePending}
        usage={model?.tokenUsage ?? null}
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
      {info.archived === true ? (
        <Badge variant="gray" className="shrink-0 px-1.5 py-0 text-[10px]">
          {t`Archived`}
        </Badge>
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

function selectOptionName(option: SelectConfigOption): string {
  for (const entry of option.options) {
    if ('value' in entry) {
      if (entry.value === option.currentValue) return entry.name;
      continue;
    }
    const current = entry.options.find((candidate) => candidate.value === option.currentValue);
    if (current !== undefined) return current.name;
  }
  return option.currentValue;
}

function hasSelectValues(option: SelectConfigOption): boolean {
  return option.options.some((entry) => ('value' in entry ? true : entry.options.length > 0));
}

/** One stable trigger for every setting an ACP agent advertises. */
function AgentSettingsPopover({ info }: { info: ThreadInfo }): ReactNode {
  const { t } = useLingui();
  const client = getAgentThreadClient();
  const configOptions = (info.configOptions ?? []).filter(
    (option) => option.type === 'boolean' || hasSelectValues(option),
  );
  const modes = info.modes;
  // `modes` predates generalized config options. Keep it as a fallback, but
  // never duplicate a mode the agent already exposes in `configOptions`.
  const showLegacyModes =
    modes != null &&
    modes.availableModes.length > 1 &&
    !configOptions.some((option) => option.category === 'mode');
  if (configOptions.length === 0 && !showLegacyModes) return null;

  const primarySelect =
    configOptions.find(
      (option): option is SelectConfigOption =>
        option.type === 'select' && option.category === 'model',
    ) ?? configOptions.find((option): option is SelectConfigOption => option.type === 'select');
  const legacyModeName = showLegacyModes
    ? modes?.availableModes.find((mode) => mode.id === modes.currentModeId)?.name
    : undefined;
  const triggerText =
    primarySelect !== undefined ? selectOptionName(primarySelect) : (legacyModeName ?? t`Settings`);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-6 max-w-48 gap-1 rounded-md px-2 text-xs"
          aria-label={t`Agent settings`}
          data-testid="agent-thread-settings"
        >
          <span className="truncate">{triggerText}</span>
          <ChevronDown className="size-3.5" data-icon="inline-end" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      {/* Hybrid menu: each multi-value select is a submenu row summarizing its
          current value; a lone boolean stays inline. The compact top level scales
          as agents expose more (and longer-described) options — the sprawl lives
          in the submenus instead of stretching one flat panel. */}
      <DropdownMenuContent align="end" className="w-60" data-testid="agent-thread-settings-popover">
        {configOptions.map((option) =>
          option.type === 'select' ? (
            <ConfigSelectSub
              key={option.id}
              option={option}
              onSelect={(value) => client.setConfigOption(info.threadId, option.id, value)}
            />
          ) : (
            <ConfigBooleanItem
              key={option.id}
              option={option}
              onCheckedChange={(value) => client.setConfigOption(info.threadId, option.id, value)}
            />
          ),
        )}
        {showLegacyModes && modes != null ? (
          <ConfigSelectSub
            option={{
              id: 'legacy-mode',
              name: t`Agent mode`,
              category: 'mode',
              type: 'select',
              currentValue: modes.currentModeId,
              options: modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name })),
            }}
            onSelect={(modeId) => client.setMode(info.threadId, modeId)}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConfigSelectSub({
  option,
  onSelect,
}: {
  option: SelectConfigOption;
  onSelect: (valueId: string) => void;
}): ReactNode {
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
          {selectOptionName(option)}
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
            <ConfigRadioItem key={entry.value} entry={entry} />
          ))}
          {groups.map((group) => (
            <Fragment key={group.group}>
              {group.name !== option.name ? (
                <DropdownMenuLabel className="font-normal text-muted-foreground">
                  {group.name}
                </DropdownMenuLabel>
              ) : null}
              {group.options.map((entry) => (
                <ConfigRadioItem key={entry.value} entry={entry} />
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
    setAnnounced(t`Loading the conversation`);
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

  // Agent still coming up: the faded agent mark with a shimmering status line so
  // the wait reads as "working". `shimmer` is a text-clipped gradient sweep, so
  // it animates the label; the icon stays faded (an SVG has no text to clip).
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
        className="size-12 opacity-25 grayscale"
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

function ThreadItem({
  item,
  threadId,
  actionable,
  terminals,
}: {
  item: RenderedItem;
  threadId: string;
  /** The thread can still take answers (live agent, not archived/dead). */
  actionable: boolean;
  terminals: Record<string, RenderedTerminal>;
}): ReactNode {
  switch (item.kind) {
    case 'message':
      return <MessageBubble item={item} />;
    case 'tool_call':
      return <ToolCallCard call={item} terminals={terminals} />;
    case 'permission':
      return <PermissionPrompt item={item} threadId={threadId} actionable={actionable} />;
    case 'runtime_consent':
      return <RuntimeConsentPrompt item={item} threadId={threadId} />;
    case 'notice':
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
          {item.text}
        </div>
      );
  }
}

function MessageBubble({ item }: { item: Extract<RenderedItem, { kind: 'message' }> }): ReactNode {
  if (item.role === 'thought') {
    return <div className="px-1 text-muted-foreground text-xs italic">{item.text}</div>;
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

function ToolCallCard({
  call,
  terminals,
}: {
  call: RenderedToolCall;
  terminals: Record<string, RenderedTerminal>;
}): ReactNode {
  const [open, setOpen] = useState(call.status !== 'completed');
  const Icon = TOOL_ICONS[call.toolKind] ?? Wrench;
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
  return (
    <div
      className="rounded-md border border-border/60 text-xs"
      data-testid="agent-thread-tool-call"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto w-full justify-start gap-1.5 rounded-md px-2 py-1.5 font-normal"
        onClick={() => setOpen((o) => !o)}
        disabled={!hasBody}
        aria-expanded={open}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{call.title}</span>
        <ToolStatusBadge status={call.status} />
      </Button>
      {open && hasBody ? (
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
              {text}
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

function ToolStatusBadge({ status }: { status: RenderedToolCall['status'] }): ReactNode {
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
    <Badge
      variant={status === 'failed' ? 'destructive' : 'secondary'}
      className="ml-auto shrink-0 px-1.5 py-0 text-[10px]"
    >
      {label}
    </Badge>
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
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              {t`running`}
            </span>
          ) : (
            <Badge
              variant={failed ? 'destructive' : 'secondary'}
              className="px-1.5 py-0 font-mono text-[10px]"
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
  const contentId = useId();
  return (
    <div data-testid="agent-thread-tool-raw-input">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto w-full justify-start gap-1 px-0 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide hover:bg-transparent"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={contentId}
      >
        {open ? (
          <ChevronDown className="size-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3" aria-hidden="true" />
        )}
        {t`Input`}
      </Button>
      {open ? (
        <pre
          id={contentId}
          className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/30 px-2 py-1 font-mono text-[11px] text-muted-foreground"
        >
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
  const client = getAgentThreadClient();
  const outcome = resolvePermissionOutcome(item);
  const pending = outcome === null;
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  // The agent's own choices may already include a refusal; only add our
  // explicit Deny (the ACP `cancelled` outcome) when they don't — without it
  // "no" exists only when the agent thinks to offer one.
  const hasRejectOption = item.options.some((option) => option.kind.startsWith('reject'));
  const options = [...item.options].sort(
    (a, b) => permissionOptionRank(a.kind) - permissionOptionRank(b.kind),
  );
  // The safest useful default is a one-time grant. A persistent grant is the
  // final focus fallback, after any refusal the agent exposes.
  const defaultOptionId =
    options.find((option) => option.kind === 'allow_once')?.optionId ??
    options.find((option) => option.kind.startsWith('reject'))?.optionId ??
    (hasRejectOption
      ? (options.find((option) => option.kind === 'allow_always')?.optionId ?? options[0]?.optionId)
      : undefined);

  const optionVariant = (kind: (typeof options)[number]['kind']) =>
    kind === 'allow_once' ? 'default' : 'outline';
  const optionLabel = (option: (typeof options)[number]) =>
    option.kind === 'reject_once' && option.name.trim().toLocaleLowerCase() === 'reject'
      ? t`Deny`
      : option.name;

  const optionButtons = options.map((option) => (
    <Button
      key={option.optionId}
      ref={option.optionId === defaultOptionId ? primaryRef : undefined}
      type="button"
      size="sm"
      variant={optionVariant(option.kind)}
      className="h-auto min-h-7 max-w-full self-start whitespace-normal text-left text-xs"
      onClick={() =>
        client.respondPermission(threadId, item.requestId, {
          kind: 'selected',
          optionId: option.optionId,
        })
      }
      data-permission-kind={option.kind}
    >
      {optionLabel(option)}
    </Button>
  ));

  const denyButton = !hasRejectOption ? (
    // ACP has no first-class per-tool deny beyond the agent's own reject
    // options; `cancelled` is the protocol's only refusal channel, and agents
    // may treat it as cancelling the whole turn. Shown only when the agent
    // offered no reject option, so "no" exists at all.
    <Button
      ref={defaultOptionId === undefined ? primaryRef : undefined}
      type="button"
      size="sm"
      variant="outline"
      className="h-7 self-start text-xs"
      onClick={() => client.respondPermission(threadId, item.requestId, { kind: 'cancelled' })}
      data-testid="agent-thread-permission-deny"
    >
      {t`Deny`}
    </Button>
  ) : null;

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

  const resolvedLabel =
    outcome === null
      ? null
      : outcome.kind === 'dismissed'
        ? // Covers timeout, Stop-cancel, and agent exit alike — don't claim a
          // specific cause the event doesn't carry.
          t`Not answered`
        : outcome.kind === 'approved'
          ? outcome.auto
            ? t`Auto-approved`
            : outcome.optionName !== null
              ? t`Approved — ${outcome.optionName}`
              : t`Approved`
          : outcome.auto
            ? t`Auto-denied`
            : outcome.optionName !== null
              ? t`Denied — ${outcome.optionName}`
              : t`Denied`;

  return (
    <div
      ref={cardRef}
      className={cn(
        'rounded-md border px-2.5 py-2 text-sm',
        pending && actionable
          ? 'border-amber-500/40 bg-amber-500/5'
          : 'border-border/60 bg-muted/20',
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
        <div className="flex flex-col items-start gap-1.5">
          {optionButtons}
          {denyButton}
        </div>
      )}
    </div>
  );
}

function permissionOptionRank(
  kind: Extract<RenderedItem, { kind: 'permission' }>['options'][number]['kind'],
): number {
  if (kind === 'allow_once') return 0;
  if (kind === 'allow_always') return 1;
  return 2;
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
  turnActive,
  cancelPending,
  onCancel,
  status,
  archived,
  resumePending,
  usage,
}: {
  info: ThreadInfo;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  canPrompt: boolean;
  turnActive: boolean;
  /** Stop was pressed and the turn hasn't ended yet. */
  cancelPending: boolean;
  onCancel: () => void;
  status: ThreadInfo['status'];
  archived: boolean;
  /** A resume op is in flight (archived thread, message queued on it). */
  resumePending: boolean;
  /** Context-window fill the agent reported; null until it reports any. */
  usage: { used?: number; size?: number } | null;
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

  return (
    <div className="p-2">
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
        <Textarea
          ref={ref}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          rows={1}
          // Stable accessible name — the placeholder is situational (and a
          // placeholder alone isn't a reliable label for screen readers).
          aria-label={t`Message ${agentName}`}
          placeholder={
            archived
              ? resumePending
                ? t`Resuming the conversation`
                : t`Pick up where you left off`
              : status === 'auth_required'
                ? t`Sign in to ${agentName} first`
                : t`Message ${agentName}`
          }
          disabled={
            archived
              ? resumePending
              : status !== 'ready' && status !== 'running' && status !== 'awaiting_permission'
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
            {turnActive ? (
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
            ) : (
              <Button
                type="button"
                size="icon-sm"
                className="rounded-lg"
                disabled={!canPrompt || draft.trim() === ''}
                onClick={onSubmit}
                aria-label={t`Send`}
                data-testid="agent-thread-send"
              >
                <ArrowUp className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
