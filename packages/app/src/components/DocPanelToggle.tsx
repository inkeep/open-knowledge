import { useLingui } from '@lingui/react/macro';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import { isNoteWindow } from '@/lib/note-window-mode';
import { cn } from '@/lib/utils';

interface DocPanelToggleProps {
  readonly isPanelCollapsed: boolean;
  readonly onTogglePanel: () => void;
  readonly className?: string;
  readonly panelId?: string;
}

export function DocPanelToggle({
  isPanelCollapsed,
  onTogglePanel,
  className,
  panelId = 'doc-panel',
}: DocPanelToggleProps) {
  const { t } = useLingui();
  const panelShortcut = formatShortcut('toggle-document-panel');
  const panelShortcutLabel = formatShortcutLabel('toggle-document-panel');
  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  if (isNoteWindow()) return null;
  return (
    <Tooltip>
      <Button
        data-doc-panel-toggle=""
        variant="ghost"
        size="icon"
        onClick={onTogglePanel}
        aria-expanded={!isPanelCollapsed}
        aria-controls={panelId}
        aria-label={
          isPanelCollapsed
            ? t`Show panel (${panelShortcutLabel})`
            : t`Hide panel (${panelShortcutLabel})`
        }
        className={cn(
          'shrink-0 text-muted-foreground',
          isElectronHost && '[-webkit-app-region:no-drag]',
          className,
        )}
        asChild
      >
        <TooltipTrigger>
          {isPanelCollapsed ? <PanelRightOpen /> : <PanelRightClose />}
        </TooltipTrigger>
      </Button>
      <TooltipContent side="bottom">
        <span>{isPanelCollapsed ? t`Show panel` : t`Hide panel`}</span>{' '}
        <Kbd aria-label={panelShortcutLabel}>{panelShortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
