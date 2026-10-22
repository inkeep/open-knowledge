import { useLingui } from '@lingui/react/macro';
import { PanelLeft, PanelRight } from 'lucide-react';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { type LogicalSide, moveChatHistory, physicalSide } from '@/lib/sidebar-side-store';
import { useDocumentDirection } from '@/lib/use-document-direction';

export function ChatHistorySideMenuItem({ side }: { readonly side: LogicalSide }) {
  const { t } = useLingui();
  const onRight = physicalSide(side, useDocumentDirection()) === 'right';
  return (
    <ContextMenuItem
      data-move-chat-history=""
      onSelect={() => moveChatHistory(onRight ? 'left' : 'right')}
    >
      {onRight ? <PanelLeft aria-hidden="true" /> : <PanelRight aria-hidden="true" />}
      {onRight ? t`Move chat history to the left` : t`Move chat history to the right`}
    </ContextMenuItem>
  );
}
