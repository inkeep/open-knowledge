import { useLingui } from '@lingui/react/macro';
import { MoreHorizontalIcon } from 'lucide-react';
import { type ReactNode, type RefObject, useLayoutEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { cn } from '@/lib/utils';
import { displayState } from './SyncStatusBadge';

export const HEADER_OVERFLOW_SLACK_PX = 8;
const HEADER_OVERFLOW_MENU_SELECTOR = '[data-header-overflow-actions]';

type SyncAttention = 'conflict' | 'offline' | 'auth-error' | 'paused';

function syncAttentionOf(status: GitSyncStatus | null): SyncAttention | null {
  if (!status?.hasRemote) return null;
  const state = displayState(status);
  if (state === 'conflict' || state === 'offline' || state === 'auth-error') return state;
  if (state === 'disabled' && status.pausedReason) return 'paused';
  return null;
}

interface HeaderOverflowActionsProps {
  syncStatus: GitSyncStatus | null;
  children: ReactNode;
  triggerRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unmountedWhileFocusedRef: RefObject<boolean>;
}

export function HeaderOverflowActions({
  syncStatus,
  children,
  triggerRef,
  open,
  onOpenChange,
  unmountedWhileFocusedRef,
}: HeaderOverflowActionsProps) {
  const { t } = useLingui();
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    return () => {
      const focused = trigger?.ownerDocument.activeElement;
      if (focused && (focused === trigger || focused.closest(HEADER_OVERFLOW_MENU_SELECTOR))) {
        unmountedWhileFocusedRef.current = true;
      }
    };
  }, [triggerRef, unmountedWhileFocusedRef]);
  const syncAttention = syncAttentionOf(syncStatus);
  const syncAttentionLabel =
    syncAttention === 'conflict'
      ? t`Conflict`
      : syncAttention === 'offline'
        ? t`Offline`
        : syncAttention === 'auth-error'
          ? t`Reconnect required`
          : syncAttention === 'paused'
            ? t`Sync paused`
            : null;
  const overflowActionsLabel = syncAttentionLabel
    ? t`More actions (${syncAttentionLabel})`
    : t`More actions`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon-sm"
          aria-label={overflowActionsLabel}
          data-testid="header-overflow-actions-trigger"
          className="relative shrink-0 text-muted-foreground"
        >
          <MoreHorizontalIcon aria-hidden="true" />
          {syncAttention ? (
            <span
              aria-hidden="true"
              data-testid="header-overflow-actions-sync-indicator"
              data-sync-attention={syncAttention}
              className={cn(
                'absolute top-0.5 end-0.5 size-1.5 rounded-full ring-1 ring-background',
                syncAttention === 'auth-error' && 'bg-destructive',
                syncAttention === 'offline' && 'bg-muted-foreground',
                (syncAttention === 'conflict' || syncAttention === 'paused') && 'bg-warning',
              )}
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t`More actions`}
        data-header-overflow-actions=""
        className="flex w-auto max-w-[calc(100vw-1rem)] flex-wrap items-center justify-end gap-2 p-2"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
