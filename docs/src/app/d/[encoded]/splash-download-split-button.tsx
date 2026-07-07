'use client';

import { ArrowDown, ChevronDown } from 'lucide-react';
import type { Ref } from 'react';
import { cn } from '@/lib/utils';
import { SplashCliPopover } from './splash-cli-popover';

interface SplashDownloadSplitButtonProps {
  downloadUrl: string;
  githubUrl: string;
  installCommand: string;
  cloneCommand: string;
  /** Forwarded onto the download segment so the cluster can focus it on a failed handoff. */
  downloadRef?: Ref<HTMLAnchorElement>;
}

/**
 * Segmented (split) download button: a primary "Download the app" face plus a
 * caret that opens the shared CLI popover (copyable commands + View on GitHub).
 * Condenses what used to be three sibling CTAs (download / CLI / GitHub) into
 * one control while keeping the deep-link "Open in macOS app" button primary.
 *
 * Each segment owns its border + rounding (left rounds left, caret rounds
 * right; the caret's lighter left border is the divider) so each hover fill is
 * bounded by its own pill corner. The Download segment is a plain
 * server-rendered <a> that works without JS; only the popover is JS-gated.
 */
export function SplashDownloadSplitButton({
  downloadUrl,
  githubUrl,
  installCommand,
  cloneCommand,
  downloadRef,
}: SplashDownloadSplitButtonProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a split button groups two controls, not form fields — role="group" is the correct ARIA pattern (fieldset is wrong here).
    <div
      role="group"
      aria-label="Download or open with other options"
      className="inline-flex items-stretch font-mono text-sm font-medium uppercase leading-[115%] tracking-[-0.64px] text-azure-blue sm:text-base"
    >
      <a
        ref={downloadRef}
        href={downloadUrl}
        data-testid="splash-download-cta"
        className={cn(
          'inline-flex touch-manipulation items-center gap-2 rounded-l-full border border-r-0 border-azure-blue px-5 py-[13px]',
          'transition-colors duration-200 outline-none hover:bg-azure-blue hover:text-white',
          'focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slide-accent',
        )}
      >
        <ArrowDown aria-hidden="true" className="size-4 shrink-0" />
        Download the app
      </a>

      <SplashCliPopover
        installCommand={installCommand}
        cloneCommand={cloneCommand}
        githubUrl={githubUrl}
        trigger={(open) => (
          <button
            type="button"
            aria-label="More ways to open this share"
            data-testid="splash-more-options"
            className={cn(
              'flex touch-manipulation items-center rounded-r-full border border-azure-blue border-l-azure-blue/40 px-3 py-[13px]',
              'transition-colors duration-200 outline-none hover:bg-azure-blue hover:text-white',
              'focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slide-accent',
            )}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
                open && 'rotate-180',
              )}
            />
          </button>
        )}
      />
    </div>
  );
}
