import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { t as tStatic } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { History, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getAgentThreadClient } from '@/lib/acp/thread-client';
import { cn } from '@/lib/utils';

export function ThreadHistoryMenu({
  archived,
  openThreadIds,
  onOpenThread,
}: {
  archived: readonly ThreadInfo[];
  openThreadIds: ReadonlySet<string>;
  onOpenThread: (threadId: string) => void;
}): ReactNode {
  const { t } = useLingui();
  const client = getAgentThreadClient();
  const [open, setOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const reasonId = useId();
  const openTabReason = t`Close this chat's tab to delete it`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setNow(Date.now());
        else setConfirmingId(null);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
              aria-label={t`Reopen a past chat`}
              data-testid="agent-thread-history"
            >
              <History aria-hidden="true" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>
          {t`Reopen a past chat`}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-1">
        <div className="max-h-80 overflow-y-auto">
          {archived.map((thread) => {
            const openAsTab = openThreadIds.has(thread.threadId);
            if (confirmingId === thread.threadId && !openAsTab) {
              return (
                <div
                  key={thread.threadId}
                  className="flex items-center gap-1.5 rounded-md bg-destructive/5 px-2 py-1"
                  data-testid="agent-thread-history-confirm"
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{t`Delete this chat?`}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    className="h-6 px-2 text-xs"
                    onClick={() => {
                      client.deleteThread(thread.threadId);
                      setConfirmingId(null);
                    }}
                    data-testid="agent-thread-history-confirm-delete"
                  >
                    {t`Delete`}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => setConfirmingId(null)}
                  >
                    {t`Cancel`}
                  </Button>
                </div>
              );
            }
            const rowReasonId = `${reasonId}-${thread.threadId}`;
            return (
              <div key={thread.threadId} className="group flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1.5"
                  onClick={() => {
                    onOpenThread(thread.threadId);
                    setOpen(false);
                  }}
                  data-testid={`agent-thread-history-open-${thread.threadId}`}
                >
                  <RegisteredAgentIcon
                    agentId={thread.agent.id}
                    iconUrl={thread.agent.iconUrl}
                    className="size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-left text-xs">{thread.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {formatRelative(thread.lastActivityAt, now)}
                  </span>
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    {}
                    <span className={cn('inline-flex', openAsTab && 'cursor-not-allowed')}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t`Delete ${thread.title}`}
                        aria-disabled={openAsTab || undefined}
                        aria-describedby={openAsTab ? rowReasonId : undefined}
                        className={cn(
                          'opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100',
                          openAsTab
                            ? 'cursor-not-allowed text-muted-foreground/50'
                            : 'text-muted-foreground hover:text-destructive',
                        )}
                        onClick={() => {
                          if (openAsTab) return;
                          setConfirmingId(thread.threadId);
                        }}
                        data-testid={`agent-thread-history-delete-${thread.threadId}`}
                      >
                        <Trash2 className="size-3" aria-hidden="true" />
                      </Button>
                      {openAsTab ? (
                        <span id={rowReasonId} className="sr-only">
                          {openTabReason}
                        </span>
                      ) : null}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={8}>
                    {openAsTab ? openTabReason : t`Delete ${thread.title}`}
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ArchivedThreadChooser({
  archived,
  onOpen,
}: {
  archived: readonly ThreadInfo[];
  onOpen: (threadId: string) => void;
}): ReactNode {
  const { t } = useLingui();
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
  }, []);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3"
      data-testid="agent-thread-empty-chooser"
    >
      <p className="px-1 text-muted-foreground text-xs">
        {t`No open chats. Reopen a past one, or start a new one with the ＋ button.`}
      </p>
      <div className="flex flex-col gap-0.5">
        {archived.map((thread) => (
          <Button
            key={thread.threadId}
            type="button"
            variant="ghost"
            className="h-auto w-full min-w-0 justify-start gap-2 px-2 py-1.5"
            onClick={() => onOpen(thread.threadId)}
            data-testid={`agent-thread-empty-open-${thread.threadId}`}
          >
            <RegisteredAgentIcon
              agentId={thread.agent.id}
              iconUrl={thread.agent.iconUrl}
              className="size-4 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate text-left text-xs">{thread.title}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {formatRelative(thread.lastActivityAt, now)}
            </span>
          </Button>
        ))}
      </div>
    </div>
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
