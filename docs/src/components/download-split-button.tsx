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
  /** Analytics slug reported as `utm_content` on every row in this control. */
  cta: DownloadCta;
  /** `pill` for in-content CTAs; `compact` for the sidebar's h-8 row. */
  variant?: 'pill' | 'compact';
  className?: string;
}

/**
 * Download CTA that never guesses an architecture: the primary segment sends
 * detected Windows and Linux visitors to the download picker, while macOS can
 * use its sole published build directly. The caret keeps every explicit build
 * plus the browser/npm path one click away.
 *
 * Server renders the neutral "Download" label pointing at the macOS floor, and
 * hydration swaps in the detected OS. Labelling by OS only after detection
 * means the button is never *wrong* — a visitor never sees "Download for
 * macOS" flash on a Windows machine — and the pre-hydration href still works
 * with JS off.
 *
 * Every destination stays in the current tab. A concrete build's redirect ends
 * at a GitHub asset served `Content-Disposition: attachment`, so the browser
 * starts the download and leaves the page untouched; Windows/Linux navigate to
 * the picker normally.
 *
 * Both segments are raw `<a>`/`<button>`, never `next/link`: the SSR href is a
 * 302 handler, so prefetching it before OS detection would start a download and
 * double-count.
 */
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
        // `noreferrer` is deliberately omitted: the Referer names the page the
        // download came from, which is how the event attributes to a docs page
        // rather than counting as direct traffic.
        rel="noopener"
        // The compact row is too narrow for "Download for macOS" — it wrapped
        // to three lines and overflowed the 32px sidebar button. Keep the
        // visible label short there and let the accessible name carry the OS.
        aria-label={osLabel}
        data-testid="download-split-primary"
        className={cn(chrome.base, chrome.primary)}
      >
        {/* No icon in the sidebar: that row has 254px for this button plus the
            GitHub star, and the icon's 24px was the difference between fitting
            and pushing the star past the sidebar edge. */}
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

/**
 * The focus ring lives on the group, not the segments: Radix restores focus to
 * the caret when the menu closes, and a ring around one half of a split button
 * reads as the caret having detached from the pill.
 */
const FOCUS_RING =
  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-slide-accent has-[:focus-visible]:ring-offset-2';

const DOWNLOAD_MENU = {
  // The sidebar install CTA gets roomier menu chrome than utility menus like
  // "Copy page", while still using the docs theme's shared fd-* colors.
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

/**
 * Each segment owns its own border and rounding — left rounds left, caret
 * rounds right, and the caret's shared border reads as the divider — so each
 * hover fill stays bounded by its own pill corner.
 *
 * The hover feedback itself belongs to the group, not the segments: styling
 * them individually made whichever half the pointer was over react while the
 * other sat still, and the two visibly came apart.
 */
const PILL = {
  group: cn(
    // An open menu holds the hover state: the pointer is on the menu by then,
    // so without this the pill drops back to rest the moment it opens.
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

// Sits beside the sidebar's GitHub Star button, so the chrome tracks
// MarketingButton's `primary` variant at size `sm` rather than inventing its own.
const COMPACT = {
  group: cn('group rounded-lg', FOCUS_RING),
  base: cn(
    'inline-flex h-8 items-center justify-center gap-2 overflow-hidden whitespace-nowrap text-sm font-medium text-white outline-none',
    'bg-azure-blue group-hover:bg-blue-dark dark:group-hover:bg-primary',
    'group-has-[[data-state=open]]:bg-blue-dark dark:group-has-[[data-state=open]]:bg-primary',
    'transition duration-200 ease-in-out cursor-pointer',
  ),
  // `min-w-0` lets the label ellipsize rather than force the row wider, so a
  // star count that grows past 3.3K can never push this off the sidebar.
  primary: 'min-w-0 flex-1 rounded-l-lg px-3',
  caret: 'shrink-0 rounded-r-lg border-l border-white/25 px-1.5',
} as const;
