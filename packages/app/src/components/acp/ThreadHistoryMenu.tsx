/**
 * Conversation-history surfaces for the sessions dock's agent threads: the
 * history popover (reopen or delete an archived conversation) and the empty-dock
 * chooser (reopen a past conversation instead of facing a dead end).
 *
 * Closing a thread tab archives it (or discards it when it never received a
 * message); these are the only ways back to an archived conversation, and the
 * only place a permanent delete lives. Lifted out of the retired AgentThreadDock
 * so the unified dock keeps the recover-from-history contract.
 */

import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { t as tStatic } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { History, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getAgentThreadClient } from '@/lib/acp/thread-client';

/**
 * The past-conversations menu: archived threads, latest activity first, each
 * reopenable as a tab. Permanent delete lives here (and only here — a tab X
 * archives a conversation, or discards it when it never received a message),
 * behind a per-row inline confirm since there is no undo.
 */
export function ThreadHistoryMenu({
  archived,
  onOpenThread,
}: {
  archived: readonly ThreadInfo[];
  onOpenThread: (threadId: string) => void;
}): ReactNode {
  const { t } = useLingui();
  const client = getAgentThreadClient();
  const [open, setOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Captured on open (event handler, not render) — React Compiler forbids
  // impure Date.now() during render. Relative labels only show while open, so
  // refreshing the reference time on each open is both correct and sufficient.
  const [now, setNow] = useState(0);
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
              aria-label={t`Restore sessions`}
              data-testid="agent-thread-history"
            >
              <History aria-hidden="true" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>
          {t`Restore sessions`}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-1">
        <div className="max-h-80 overflow-y-auto">
          {archived.map((thread) =>
            confirmingId === thread.threadId ? (
              <div
                key={thread.threadId}
                className="flex items-center gap-1.5 rounded-md bg-destructive/5 px-2 py-1"
                data-testid="agent-thread-history-confirm"
              >
                <span className="min-w-0 flex-1 truncate text-xs">
                  {t`Delete this conversation?`}
                </span>
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
            ) : (
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t`Delete ${thread.title}`}
                      className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-focus-within:opacity-100 group-hover:opacity-100"
                      onClick={() => setConfirmingId(thread.threadId)}
                      data-testid={`agent-thread-history-delete-${thread.threadId}`}
                    >
                      <Trash2 className="size-3" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={8}>
                    {t`Delete ${thread.title}`}
                  </TooltipContent>
                </Tooltip>
              </div>
            ),
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The empty-dock chooser: past conversations, latest first, each reopenable in
 * one click — so an empty dock with history is a way back in, not a dead end.
 * The caller renders this only when there is archived history.
 */
export function ArchivedThreadChooser({
  archived,
  onOpen,
}: {
  archived: readonly ThreadInfo[];
  onOpen: (threadId: string) => void;
}): ReactNode {
  const { t } = useLingui();
  // Date.now() is impure — capture it in an effect (React Compiler forbids it in
  // render). Refreshed each time the chooser mounts (the dock reaching zero open
  // sessions), which is exactly when the relative labels below are shown.
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
        {t`No open conversations. Reopen a past one, or start a session with the ＋ button.`}
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

/** Coarse relative-time label for a conversation's last activity. */
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
