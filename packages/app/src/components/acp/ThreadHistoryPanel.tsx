import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { t as tStatic } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { ChevronLeft, History, Pencil, Search, Trash2, X } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { DeleteConfirmationDialog } from '@/components/DeleteConfirmationDialog';
import { AlertDialog } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getAgentThreadClient } from '@/lib/acp/thread-client';
import { cn } from '@/lib/utils';

interface ThreadHistoryContentProps {
  readonly threads: readonly ThreadInfo[];
  readonly openThreadIds: ReadonlySet<string>;
  readonly activeThreadId: string | null;
  readonly onSelectThread: (threadId: string) => void;
}

export type ThreadHistoryMode = 'cover' | 'docked';

interface ThreadHistorySearchState {
  readonly query: string;
  readonly setQuery: (query: string) => void;
}

const RELATIVE_TIME_TICK_MS = 30_000;

const ThreadHistorySearchContext = createContext<ThreadHistorySearchState | null>(null);

interface ThreadDeleteDialogController {
  readonly open: (thread: ThreadInfo) => void;
}

export function ThreadHistorySearchProvider({
  scope,
  children,
}: {
  readonly scope: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const [query, setQuery] = useState('');
  useEffect(() => {
    void scope;
    setQuery('');
  }, [scope]);
  return (
    <ThreadHistorySearchContext value={{ query, setQuery }}>{children}</ThreadHistorySearchContext>
  );
}

export function ThreadHistoryToggle({
  open,
  panelId,
  triggerRef,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly panelId: string;
  readonly triggerRef?: RefObject<HTMLButtonElement | null>;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const { t } = useLingui();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
          aria-label={t`Chat history`}
          aria-expanded={open}
          aria-controls={panelId}
          data-testid="agent-thread-history"
          onClick={() => onOpenChange(!open)}
        >
          <History aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        {t`Chat history`}
      </TooltipContent>
    </Tooltip>
  );
}

function ThreadDeleteDialog({
  controllerRef,
}: {
  readonly controllerRef: RefObject<ThreadDeleteDialogController | null>;
}): ReactNode {
  const { t } = useLingui();
  const [thread, setThread] = useState<ThreadInfo | null>(null);
  useImperativeHandle(controllerRef, () => ({ open: setThread }), []);

  if (thread === null) return null;

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) setThread(null);
      }}
    >
      <DeleteConfirmationDialog
        itemName={thread.title}
        customTitle={t`Delete chat?`}
        isSubmitting={false}
        onDelete={() => {
          getAgentThreadClient().deleteThread(thread.threadId);
          setThread(null);
        }}
      />
    </AlertDialog>
  );
}

function ThreadHistoryRow({
  thread,
  openAsTab,
  active,
  mode,
  now,
  reasonId,
  openTabReason,
  deleteDialogRef,
  onSelectThread,
  onDismiss,
}: {
  readonly thread: ThreadInfo;
  readonly openAsTab: boolean;
  readonly active: boolean;
  readonly mode: ThreadHistoryMode;
  readonly now: number;
  readonly reasonId: string;
  readonly openTabReason: string;
  readonly deleteDialogRef: RefObject<ThreadDeleteDialogController | null>;
  readonly onSelectThread: (threadId: string) => void;
  readonly onDismiss: (reason: 'explicit' | 'selection') => void;
}): ReactNode {
  const { t } = useLingui();
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const cancelRenameRef = useRef(false);

  if (draftTitle !== null) {
    const endRename = (): void => {
      const title = draftTitle.trim();
      if (!cancelRenameRef.current && title !== '' && title !== thread.title) {
        getAgentThreadClient().renameThread(thread.threadId, title);
      }
      cancelRenameRef.current = false;
      setDraftTitle(null);
    };
    return (
      <SidebarMenuItem className="[contain-intrinsic-size:auto_2.25rem] [content-visibility:auto]">
        <div className="rounded-md bg-sidebar-accent p-1" data-testid="agent-thread-history-rename">
          <Input
            autoFocus
            value={draftTitle}
            aria-label={t`Chat name`}
            className="h-7 min-w-0 text-sm"
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelRenameRef.current = true;
                event.currentTarget.blur();
              }
            }}
            onBlur={endRename}
            data-testid="agent-thread-history-rename-input"
          />
        </div>
      </SidebarMenuItem>
    );
  }

  const rowReasonId = `${reasonId}-${thread.threadId}`;
  const deleteBlocked = openAsTab || thread.archived !== true;
  return (
    <SidebarMenuItem
      className={cn(
        'rounded-md [--thread-row-destructive-foreground:var(--sidebar-hover-destructive-foreground)] [--thread-row-foreground:var(--sidebar-hover-foreground)] [--thread-row-muted-foreground:var(--sidebar-hover-muted-foreground)] [contain-intrinsic-size:auto_2.25rem] [content-visibility:auto]',
        active
          ? 'bg-[var(--thread-row-bg)] [--thread-row-bg:var(--sidebar-selected)] [--thread-row-destructive-foreground:var(--sidebar-selected-destructive-foreground)] [--thread-row-foreground:var(--sidebar-selected-foreground)] [--thread-row-muted-foreground:var(--sidebar-selected-muted-foreground)]'
          : 'hover:bg-[var(--thread-row-bg)] focus-within:bg-[var(--thread-row-bg)] [--thread-row-bg:var(--sidebar-hover)]',
      )}
    >
      <SidebarMenuButton
        type="button"
        size="default"
        isActive={active}
        aria-current={active ? 'true' : undefined}
        className="h-9 bg-transparent pr-2! text-sidebar-foreground hover:bg-transparent hover:text-[var(--thread-row-foreground)] active:bg-transparent data-active:bg-transparent data-active:text-[var(--thread-row-foreground)] data-active:hover:bg-transparent group-focus-within/menu-item:text-[var(--thread-row-foreground)] group-hover/menu-item:text-[var(--thread-row-foreground)]"
        onClick={() => {
          onSelectThread(thread.threadId);
          if (mode === 'cover') onDismiss('selection');
        }}
        data-testid={`agent-thread-history-open-${thread.threadId}`}
      >
        <RegisteredAgentIcon
          agentId={thread.agent.id}
          iconUrl={thread.agent.iconUrl}
          className="size-4 shrink-0"
        />
        <span className="min-w-0 flex-1 truncate text-start">{thread.title}</span>
        <span className="shrink-0 text-2xs text-[var(--thread-row-muted-foreground)] motion-safe:transition-opacity group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0">
          {formatRelative(thread.lastActivityAt, now)}
        </span>
      </SidebarMenuButton>
      <SidebarMenuAction
        asChild
        showOnHover
        className="pointer-events-none inset-y-0 top-0! end-0! z-10 aspect-auto h-auto w-auto overflow-visible rounded-none rounded-e-md bg-[var(--thread-row-bg)] p-1 opacity-0 shadow-none before:pointer-events-none before:absolute before:inset-y-0 before:end-full before:w-8 before:bg-[linear-gradient(to_right,transparent,var(--thread-row-bg))] after:hidden hover:bg-[var(--thread-row-bg)] group-focus-within/menu-item:pointer-events-auto group-hover/menu-item:pointer-events-auto rtl:before:bg-[linear-gradient(to_left,transparent,var(--thread-row-bg))]"
      >
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t`Rename ${thread.title}`}
                className="rounded-sm bg-transparent text-[var(--thread-row-muted-foreground)] shadow-none hover:bg-transparent hover:text-[var(--thread-row-foreground)]"
                onClick={() => {
                  cancelRenameRef.current = false;
                  setDraftTitle(thread.title);
                }}
                data-testid={`agent-thread-history-rename-${thread.threadId}`}
              >
                <Pencil className="size-3" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={8}>
              {t`Rename chat`}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn('inline-flex', deleteBlocked && 'cursor-not-allowed')}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Delete ${thread.title}`}
                  aria-disabled={deleteBlocked || undefined}
                  aria-describedby={deleteBlocked ? rowReasonId : undefined}
                  className={cn(
                    deleteBlocked
                      ? 'pointer-events-none cursor-not-allowed bg-transparent text-muted-foreground/35 shadow-none hover:bg-transparent hover:text-muted-foreground/35 active:translate-y-0'
                      : 'rounded-sm bg-transparent text-[var(--thread-row-muted-foreground)] shadow-none hover:bg-transparent hover:text-[var(--thread-row-destructive-foreground)]',
                  )}
                  onClick={() => {
                    if (deleteBlocked) return;
                    deleteDialogRef.current?.open(thread);
                  }}
                  data-testid={`agent-thread-history-delete-${thread.threadId}`}
                >
                  <Trash2 className="size-3" aria-hidden="true" />
                </Button>
                {deleteBlocked ? (
                  <span id={rowReasonId} className="sr-only">
                    {openTabReason}
                  </span>
                ) : null}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={8}>
              {deleteBlocked ? openTabReason : t`Delete chat`}
            </TooltipContent>
          </Tooltip>
        </div>
      </SidebarMenuAction>
    </SidebarMenuItem>
  );
}

export function ThreadHistoryPanel({
  threads,
  openThreadIds,
  activeThreadId,
  onSelectThread,
  mode,
  panelId,
  onDismiss,
  newChatControl,
}: ThreadHistoryContentProps & {
  readonly mode: ThreadHistoryMode;
  readonly panelId: string;
  readonly onDismiss: (reason: 'explicit' | 'selection') => void;
  readonly newChatControl?: ReactNode;
}): ReactNode {
  const { t } = useLingui();
  const search = use(ThreadHistorySearchContext);
  if (search === null) throw new Error('ThreadHistoryPanel requires ThreadHistorySearchProvider');
  const { query, setQuery } = search;
  const [now, setNow] = useState(() => Date.now());
  const deleteDialogRef = useRef<ThreadDeleteDialogController>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const openedInModeRef = useRef(mode);
  const reasonId = useId();
  const openTabReason = t`Close this chat's tab to delete it`;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleThreads = threads
    .filter((thread) => thread.title.toLowerCase().includes(normalizedQuery))
    .sort(compareHistoryThreads);
  const todayThreads = visibleThreads.filter((thread) =>
    isSameLocalDate(thread.lastActivityAt, now),
  );
  const olderThreads = visibleThreads.filter(
    (thread) => !isSameLocalDate(thread.lastActivityAt, now),
  );
  const groups = [
    { key: 'today', label: t`Today`, threads: todayThreads },
    { key: 'older', label: t`Older`, threads: olderThreads },
  ].filter((group) => group.threads.length > 0);
  const clearQuery = (): void => {
    setQuery('');
    searchInputRef.current?.focus();
  };
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    searchInputRef.current?.focus({ preventScroll: openedInModeRef.current === 'cover' });
  }, []);
  return (
    <aside
      id={panelId}
      aria-label={t`Chat history`}
      className="flex h-full min-h-0 w-full flex-col bg-muted/20 text-sidebar-foreground [--sidebar-accent-foreground:var(--foreground)]"
      data-testid="agent-thread-history-panel"
      data-history-mode={mode}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.defaultPrevented)
          return;
        event.preventDefault();
        onDismiss('explicit');
      }}
    >
      <SidebarHeader className="shrink-0 gap-0">
        {mode === 'cover' ? (
          <div className="mb-2 flex h-8 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Back`}
                  data-testid="agent-thread-history-back"
                  onClick={() => onDismiss('explicit')}
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={8}>
                {t`Back`}
              </TooltipContent>
            </Tooltip>
            <h2 className="font-mono text-xs font-normal uppercase tracking-wide text-muted-foreground">
              {t`Chat history`}
            </h2>
          </div>
        ) : null}
        <InputGroup className="border-none bg-muted-foreground/5">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchInputRef}
            type="search"
            className="[&::-webkit-search-cancel-button]:hidden"
            name="chat-history-search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            aria-label={t`Search chat history`}
            placeholder={t`Search chats`}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query !== '' ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label={t`Clear history search`}
                onClick={clearQuery}
              >
                <X aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </SidebarHeader>
      <SidebarContent className="px-1 pb-1 scroll-fade-mask">
        <div
          role="status"
          aria-atomic="true"
          className={threads.length === 0 ? 'flex min-h-0 flex-1 flex-col' : undefined}
        >
          {threads.length === 0 ? (
            <Empty className="min-h-32 p-4">
              <EmptyHeader>
                <EmptyTitle className="font-normal text-muted-foreground" asChild>
                  <h2>{t`No chats yet.`}</h2>
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : visibleThreads.length === 0 ? (
            <h2 className="px-4 py-6 text-center text-sm font-normal text-muted-foreground">
              {t`No chats match your search`}
            </h2>
          ) : null}
        </div>
        {groups.map((group) => (
          <SidebarGroup key={group.key} className="mt-1 p-0 first:mt-0">
            <SidebarGroupLabel
              asChild
              className="text-xs text-muted-foreground font-normal uppercase tracking-wide font-mono"
            >
              <h2 id={`${reasonId}-${group.key}`}>{group.label}</h2>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu aria-labelledby={`${reasonId}-${group.key}`}>
                {group.threads.map((thread) => (
                  <ThreadHistoryRow
                    key={thread.threadId}
                    thread={thread}
                    openAsTab={openThreadIds.has(thread.threadId)}
                    active={activeThreadId === thread.threadId}
                    mode={mode}
                    now={now}
                    reasonId={reasonId}
                    openTabReason={openTabReason}
                    deleteDialogRef={deleteDialogRef}
                    onSelectThread={onSelectThread}
                    onDismiss={onDismiss}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      {newChatControl != null ? (
        <SidebarFooter className="shrink-0 gap-0">{newChatControl}</SidebarFooter>
      ) : null}
      <ThreadDeleteDialog controllerRef={deleteDialogRef} />
    </aside>
  );
}

function compareHistoryThreads(a: ThreadInfo, b: ThreadInfo): number {
  if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
  if (a.threadId < b.threadId) return -1;
  if (a.threadId > b.threadId) return 1;
  return 0;
}

function isSameLocalDate(a: number, b: number): boolean {
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function formatRelative(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return tStatic`just now`;
  if (diff < 3_600_000) {
    const minutes = Math.round(diff / 60_000);
    return tStatic`${minutes}m ago`;
  }
  if (diff < 86_400_000) {
    const hours = Math.round(diff / 3_600_000);
    return tStatic`${hours}h ago`;
  }
  const days = Math.round(diff / 86_400_000);
  return tStatic`${days}d ago`;
}
