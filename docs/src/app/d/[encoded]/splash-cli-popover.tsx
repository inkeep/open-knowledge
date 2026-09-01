'use client';

import { ArrowUpRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  type DetectedOs,
  orderTargetsForOs,
  targetQuery,
  WEB_APP_HREF,
  WEB_APP_LABEL,
} from '@/lib/download-targets';
import { cn } from '@/lib/utils';
import { SplashCliBlock } from './splash-cli-block';

interface SplashCliPopoverProps {
  trigger: (open: boolean) => ReactNode;
  installCommand: string;
  cloneCommand?: string;
  githubUrl?: string;
  platformBaseUrl?: string;
  detectedOs?: DetectedOs;
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}

function withTargetQuery(base: string, query: string): string {
  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}

const PLATFORM_ROW = cn(
  'block rounded px-2 py-1.5 -mx-2 text-sm text-slide-text',
  'transition-colors hover:bg-slide-text/[0.06]',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slide-accent',
);

export function SplashCliPopover({
  trigger,
  installCommand,
  cloneCommand,
  githubUrl,
  platformBaseUrl,
  detectedOs = 'unknown',
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
        aria-label="More ways to install"
        data-testid="splash-more-options-panel"
        className="w-88 max-w-[calc(100vw-2rem)] text-left"
      >
        {platformBaseUrl ? (
          <div className="mb-4" data-testid="splash-platform-list">
            <p className="mb-1.5 font-mono text-xs uppercase tracking-wide text-slide-muted">
              Other platforms
            </p>
            <ul className="flex flex-col">
              {orderTargetsForOs(detectedOs).map((target) => (
                <li key={target.id}>
                  <a
                    href={withTargetQuery(platformBaseUrl, targetQuery(target))}
                    onClick={() => setOpen(false)}
                    className={PLATFORM_ROW}
                  >
                    {target.label}
                  </a>
                </li>
              ))}
              <li>
                <a href={WEB_APP_HREF} onClick={() => setOpen(false)} className={PLATFORM_ROW}>
                  {WEB_APP_LABEL}
                </a>
              </li>
            </ul>
          </div>
        ) : null}

        <SplashCliBlock installCommand={installCommand} cloneCommand={cloneCommand} showHeading />

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
