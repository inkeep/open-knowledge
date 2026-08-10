'use client';

import { ArrowDown, ChevronDown } from 'lucide-react';
import type { Ref } from 'react';
import { type DetectedOs, downloadLabelForOs } from '@/lib/download-targets';
import { cn } from '@/lib/utils';
import { SplashCliPopover } from './splash-cli-popover';

interface SplashDownloadSplitButtonProps {
  downloadUrl: string;
  /** Query-less download route the panel appends each build's params to. */
  platformBaseUrl: string;
  detectedOs: DetectedOs;
  /** Omitted on the fallback screens — no decoded share means no repo to view. */
  githubUrl?: string;
  installCommand: string;
  /** Omitted on the fallback screens — no repo to clone, so install only. */
  cloneCommand?: string;
  /** Forwarded onto the download segment so the cluster can focus it on a failed handoff. */
  downloadRef?: Ref<HTMLAnchorElement>;
  /**
   * Accessible name for the caret. Defaults to the share wording; the fallback
   * screens override it, because there is no share on those pages.
   */
  moreOptionsLabel?: string;
  /**
   * `secondary` (default) for the share splash, where "Open in desktop app"
   * carries the primary weight. `primary` for the fallback screens, where this
   * is the only action on the page.
   */
  variant?: 'primary' | 'secondary';
}

/**
 * Both halves react together, driven from the group rather than each segment,
 * and hold the state while the panel is open. Per-segment hover made whichever
 * half the pointer was over react while the other sat still, so the control
 * visibly came apart — most obviously once the panel opened and the pointer
 * was parked on the caret.
 *
 * `secondary` is the share-splash look: it sits beside "Open in desktop app",
 * which owns the primary weight there, so this one outlines at rest and fills
 * on hover. `primary` is for the fallback screens, where the download IS the
 * page's only action and an outline reads as the lesser of two choices the
 * visitor never gets offered.
 */
const VARIANT = {
  secondary: {
    rest: 'text-azure-blue',
    segment: 'border-azure-blue',
    divider: 'border-l-azure-blue/40',
    fill: cn(
      'group-hover:bg-azure-blue group-hover:text-white',
      'group-has-[[data-state=open]]:bg-azure-blue group-has-[[data-state=open]]:text-white',
    ),
  },
  primary: {
    rest: 'text-white',
    segment: 'border-azure-blue bg-azure-blue',
    // A white seam, not a blue one: on a solid fill the darker rule read as a
    // crack rather than a divider between two halves of one control.
    divider: 'border-l-white/25',
    fill: cn(
      'group-hover:bg-blue-dark group-hover:border-blue-dark',
      'dark:group-hover:bg-primary dark:group-hover:border-primary',
      'group-has-[[data-state=open]]:bg-blue-dark group-has-[[data-state=open]]:border-blue-dark',
      'dark:group-has-[[data-state=open]]:bg-primary dark:group-has-[[data-state=open]]:border-primary',
    ),
  },
} as const;

/**
 * Segmented (split) download button: a primary "Download the app" face plus a
 * caret that opens the shared CLI popover (copyable commands + View on GitHub).
 * Condenses what used to be three sibling CTAs (download / CLI / GitHub) into
 * one control while keeping the deep-link "Open in desktop app" button primary.
 *
 * Each segment owns its border + rounding (left rounds left, caret rounds
 * right; the caret's lighter left border is the divider) so the shared fill
 * stays bounded by the pill's own corners. The Download segment is a plain
 * server-rendered <a> that works without JS; only the popover is JS-gated.
 */
export function SplashDownloadSplitButton({
  downloadUrl,
  platformBaseUrl,
  detectedOs,
  githubUrl,
  installCommand,
  cloneCommand,
  downloadRef,
  moreOptionsLabel = 'More ways to open this share',
  variant = 'secondary',
}: SplashDownloadSplitButtonProps) {
  const chrome = VARIANT[variant];

  return (
    // biome-ignore lint/a11y/useSemanticElements: a split button groups two controls, not form fields — role="group" is the correct ARIA pattern (fieldset is wrong here).
    <div
      role="group"
      aria-label="Download or open with other options"
      className={cn(
        'group inline-flex items-stretch font-mono text-sm font-medium uppercase leading-[115%] tracking-[-0.64px] sm:text-base',
        chrome.rest,
      )}
    >
      <a
        ref={downloadRef}
        href={downloadUrl}
        data-testid="splash-download-cta"
        className={cn(
          'inline-flex touch-manipulation items-center gap-2 rounded-l-full border border-r-0 px-5 py-[13px]',
          'transition-colors duration-200 outline-none',
          chrome.segment,
          chrome.fill,
          'focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slide-accent',
        )}
      >
        <ArrowDown aria-hidden="true" className="size-4 shrink-0" />
        {/* Keep the neutral copy as the SSR floor — a share recipient sees this
            before detection resolves, and "Download for macOS" flashing on a
            Windows machine is worse than a generic label. */}
        {detectedOs === 'unknown' ? 'Download the app' : downloadLabelForOs(detectedOs)}
      </a>

      <SplashCliPopover
        installCommand={installCommand}
        cloneCommand={cloneCommand}
        githubUrl={githubUrl}
        platformBaseUrl={platformBaseUrl}
        detectedOs={detectedOs}
        trigger={(open) => (
          <button
            type="button"
            aria-label={moreOptionsLabel}
            data-testid="splash-more-options"
            className={cn(
              'flex touch-manipulation items-center rounded-r-full border px-3 py-[13px]',
              'transition-colors duration-200 outline-none',
              chrome.segment,
              chrome.divider,
              chrome.fill,
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
