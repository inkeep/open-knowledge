/**
 * "Start a new chat" — the queue send's one override row.
 *
 * The send decides its own destination: a live chat takes the batch, and with
 * none open it starts one. That is the answer in almost every case, so it is
 * the button's behavior rather than a choice to make each time.
 *
 * This row exists for the case the automatic answer gets wrong: a chat is open,
 * but this batch is unrelated to it and belongs in a clean one. Without it,
 * having any chat open would make a fresh turn unreachable — a capability lost
 * to a default. It renders ONLY when a chat is open; with none, "start a new
 * chat" is what the button already does and the row would be a duplicate.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import { DropdownMenuGroup, DropdownMenuItem } from '@/components/ui/dropdown-menu';

export function QueueNewChatRow({ onStartNewChat }: { onStartNewChat: () => void }) {
  const { t } = useLingui();
  return (
    <DropdownMenuGroup aria-label={t`Send queue to`}>
      <DropdownMenuItem
        onSelect={onStartNewChat}
        className="gap-2"
        data-testid="comment-queue-send-new"
      >
        <Plus className="size-4" />
        <span className="flex-1 truncate">
          <Trans>Start a new chat</Trans>
        </span>
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}
