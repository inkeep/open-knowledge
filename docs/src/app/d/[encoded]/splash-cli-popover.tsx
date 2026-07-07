'use client';

import { ArrowUpRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { SplashCliBlock } from './splash-cli-block';

interface SplashCliPopoverProps {
  /**
   * Opener element, wrapped in PopoverTrigger asChild. A render function so the
   * caller can animate a caret off the `open` state. Both callers are client
   * components, so the function prop never crosses the RSC boundary.
   */
  trigger: (open: boolean) => ReactNode;
  installCommand: string;
  /** Omitted on the fallback screen (no resolved repo to clone). */
  cloneCommand?: string;
  /** When set, a "View on GitHub" link-out is appended below the CLI block. */
  githubUrl?: string;
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}

/**
 * The shared "Open with CLI" popover: a copyable install (+ clone) block under
 * the "Open with CLI" header, optionally followed by a View-on-GitHub link.
 * Used by the macOS Download split button (caret trigger + GitHub) and the
 * invalid-share fallback ("Open with CLI" button, install-only) so the two
 * panels can't drift. Portalled to <body> (never clipped / out-stacked) with
 * Radix focus-trapping + outside-click/Escape dismissal.
 */
export function SplashCliPopover({
  trigger,
  installCommand,
  cloneCommand,
  githubUrl,
  align = 'end',
  sideOffset = 12,
}: SplashCliPopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger(open)}</PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={sideOffset}
        aria-label="Open with CLI"
        data-testid="splash-more-options-panel"
        className="w-88 max-w-[calc(100vw-2rem)] text-left"
      >
        <SplashCliBlock
          installCommand={installCommand}
          cloneCommand={cloneCommand}
          wrapperClassName=""
          showHeading
        />

        {githubUrl ? (
          <a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            data-testid="splash-github-cta"
            className={cn(
              'mt-4 inline-flex w-fit touch-manipulation items-center gap-1.5 font-mono text-sm uppercase tracking-wide text-slide-muted',
              'transition-colors hover:text-slide-text',
              'focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slide-accent',
            )}
          >
            View on GitHub
            <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
          </a>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
