import { Trans, useLingui } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import { DropdownMenuGroup, DropdownMenuItem } from '@/components/ui/dropdown-menu';

export function QueueNewChatRow({ onStartNewChat }: { onStartNewChat: () => void }) {
  const { t } = useLingui();
  return (
    <DropdownMenuGroup aria-label={t`Send comments to`}>
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
