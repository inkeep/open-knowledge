import type { ComponentProps, FC } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  formatShortcut,
  formatShortcutLabel,
  type KeyboardShortcutId,
} from '@/lib/keyboard-shortcuts';

export interface SidebarToolbarButtonProps extends ComponentProps<typeof Button> {
  icon: FC<ComponentProps<'svg'>>;
  label: string;
  shortcutId?: KeyboardShortcutId;
}

const ToolbarTooltipContent: FC<Pick<SidebarToolbarButtonProps, 'label' | 'shortcutId'>> = ({
  label,
  shortcutId,
}) => {
  return (
    <TooltipContent>
      <span>{label}</span>
      {shortcutId ? (
        <>
          {' '}
          <Kbd aria-label={formatShortcutLabel(shortcutId)}>{formatShortcut(shortcutId)}</Kbd>
        </>
      ) : null}
    </TooltipContent>
  );
};

export const SidebarToolbarButton: FC<SidebarToolbarButtonProps> = ({
  icon: Icon,
  label,
  shortcutId,
  ...props
}) => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} {...props}>
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <ToolbarTooltipContent label={label} shortcutId={shortcutId} />
    </Tooltip>
  );
};
