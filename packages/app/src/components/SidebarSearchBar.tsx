
import { incrementJsxRenderFailure } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { Search } from 'lucide-react';
import type { ErrorInfo } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
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
  return (
    <Button
      variant="outline"
      onClick={onClick}
      data-telemetry-event="ok.sidebar.search_pill.click"
      className={cn(
        'rounded-lg h-9 w-full justify-start gap-2 px-3 font-normal text-muted-foreground',
        className,
      )}
    >
      <Search aria-hidden="true" />
      <span className="flex-1 text-left text-sm">
        <Trans>Search</Trans>
      </span>
      <Kbd className="text-foreground/70">{formatShortcut('command-palette')}</Kbd>
    </Button>
  );
}
