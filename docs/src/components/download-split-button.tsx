'use client';

import { ChevronDown, Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  classifyDownloadOs,
  type DetectedOs,
  downloadHrefForDetectedOs,
  downloadHrefForTarget,
  downloadLabelForOs,
  orderTargetsForOs,
  readPlatformInput,
  WEB_APP_HREF,
  WEB_APP_LABEL,
} from '@/lib/download-targets';
import type { DownloadCta } from '@/lib/site';
import { cn } from '@/lib/utils';

interface DownloadSplitButtonProps {
  cta: DownloadCta;
  variant?: 'pill' | 'compact';
  className?: string;
}

export function DownloadSplitButton({
  cta,
  variant = 'pill',
  className,
}: DownloadSplitButtonProps) {
  const [os, setOs] = useState<DetectedOs>('unknown');

  useEffect(() => {
    setOs(classifyDownloadOs(readPlatformInput()));
  }, []);

  const chrome = variant === 'compact' ? COMPACT : PILL;
  const osLabel = downloadLabelForOs(os);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a split button groups two controls, not form fields — role="group" is the correct ARIA pattern (fieldset is wrong here).
    <div
      role="group"
      aria-label="Download OpenKnowledge"
      data-testid="download-split"
      className={cn('not-prose inline-flex items-stretch', chrome.group, className)}
    >
      <a
        href={downloadHrefForDetectedOs(cta, os)}
        rel="noopener"
        aria-label={osLabel}
        data-testid="download-split-primary"
        className={cn(chrome.base, chrome.primary)}
      >
        {}
        {variant === 'compact' ? null : <Download className="size-4 shrink-0" aria-hidden="true" />}
        <span className="truncate">{variant === 'compact' ? 'Download' : osLabel}</span>
      </a>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Choose a different platform"
          data-testid="download-split-caret"
          className={cn(chrome.base, chrome.caret)}
        >
          <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className={DOWNLOAD_MENU.content}
        >
          {orderTargetsForOs(os).map((target) => (
            <DropdownMenuItem key={target.id} asChild className={DOWNLOAD_MENU.item}>
              <a href={downloadHrefForTarget(cta, target)} rel="noopener">
                {target.label}
              </a>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator className={DOWNLOAD_MENU.separator} />
          <DropdownMenuItem asChild className={DOWNLOAD_MENU.item}>
            <a href={WEB_APP_HREF}>{WEB_APP_LABEL}</a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const FOCUS_RING =
  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-slide-accent has-[:focus-visible]:ring-offset-2';

const DOWNLOAD_MENU = {
  content: cn(
    'min-w-64 rounded-[10px] border border-fd-border bg-fd-popover p-1.5 text-fd-popover-foreground',
    'shadow-[0_18px_48px_rgba(35,31,32,0.12)] dark:shadow-[0_18px_48px_rgba(0,0,0,0.45)]',
  ),
  item: cn(
    'cursor-pointer rounded-md px-3 py-2 text-sm text-fd-popover-foreground whitespace-nowrap',
    'focus:bg-fd-accent focus:text-fd-accent-foreground',
  ),
  separator: '-mx-1.5 my-1.5 bg-fd-border',
} as const;

const PILL = {
  group: cn(
    'rounded-full transition-opacity hover:opacity-90 has-[[data-state=open]]:opacity-90',
    FOCUS_RING,
  ),
  base: cn(
    'inline-flex items-center gap-2 whitespace-nowrap px-5 py-2.5 text-sm font-medium outline-none',
    'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900',
    'cursor-pointer',
  ),
  primary: 'rounded-l-full',
  caret: 'rounded-r-full border-l border-white/25 px-3 dark:border-neutral-900/25',
} as const;

const COMPACT = {
  group: cn('group rounded-lg', FOCUS_RING),
  base: cn(
    'inline-flex h-8 items-center justify-center gap-2 overflow-hidden whitespace-nowrap text-sm font-medium text-white outline-none',
    'bg-azure-blue group-hover:bg-blue-dark dark:group-hover:bg-primary',
    'group-has-[[data-state=open]]:bg-blue-dark dark:group-has-[[data-state=open]]:bg-primary',
    'transition duration-200 ease-in-out cursor-pointer',
  ),
  primary: 'min-w-0 flex-1 rounded-l-lg px-3',
  caret: 'shrink-0 rounded-r-lg border-l border-white/25 px-1.5',
} as const;
