import { incrementJsxRenderFailure } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { Search } from 'lucide-react';
import type { ErrorInfo } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcut } from '@/lib/keyboard-shortcuts';
import { cn } from '@/lib/utils';

interface SidebarSearchBarProps {
  onClick: () => void;
  className?: string;
}

export function onPillRenderError(error: unknown, info: ErrorInfo): void {
  const err = error instanceof Error ? error : new Error(String(error));
  console.warn(
    JSON.stringify({
      event: 'jsx-render-failure',
      component: 'sidebarSearchPill',
      rawComponentName: 'sidebarSearchPill',
      error: String(err),
      stack: info.componentStack,
    }),
  );
  incrementJsxRenderFailure('sidebarSearchPill');
}

export function SidebarSearchBar({ onClick, className }: SidebarSearchBarProps) {
  const { t } = useLingui();
  const label = t`Search`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-label={label}
          data-telemetry-event="ok.sidebar.search_pill.click"
          className={cn('shrink-0 text-muted-foreground', className)}
        >
          <Search aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        <Kbd className="text-foreground/70">{formatShortcut('command-palette')}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
