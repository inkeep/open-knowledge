import { Download } from 'lucide-react';
import { GitHubIcon } from '@/components/icons/github';
import { MarketingButton } from '@/components/marketing-button';
import { DOWNLOAD_ROUTE, GITHUB_URL } from '@/lib/site';

// Compact for the button label (e.g. "1.5K"); full comma-grouped for the tooltip.
const compactStars = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const fullStars = new Intl.NumberFormat('en-US');

/**
 * Two CTAs rendered in the docs sidebar `banner` slot, directly beneath the
 * search bar. URLs share the source of truth in site.ts. `stars` is the live
 * GitHub count (null when the fetch fails — the count is then omitted).
 */
export function DocsSidebarCta({ stars }: { stars: number | null }) {
  return (
    <div className="flex gap-2">
      {/* MarketingButton (matches the docs Subscribe button). DOWNLOAD_ROUTE
          starts with /download/, so MarketingButton renders it as a raw <a>
          via its isRedirectRoute path — next/link never prefetches it, which
          would fire the 302 and inflate download counts. */}
      <MarketingButton
        href={DOWNLOAD_ROUTE}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Download for macOS"
        title="Download for macOS"
        variant="primary"
        size="sm"
        className="h-8 flex-1 justify-center gap-2 rounded-lg px-3"
      >
        <span className="flex items-center gap-2">
          <Download className="size-4" aria-hidden="true" />
          Download
        </span>
      </MarketingButton>
      <MarketingButton
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Star on GitHub"
        title={stars != null ? `${fullStars.format(stars)} GitHub stars` : 'Star on GitHub'}
        variant="outline"
        size="sm"
        className="h-8 flex-1 justify-center gap-2 rounded-lg px-3 uppercase tracking-[-0.64px] text-sm sm:text-sm border-border bg-fd-secondary text-fd-secondary-foreground hover:bg-fd-accent hover:text-fd-accent-foreground"
      >
        <span className="flex items-center gap-2">
          <GitHubIcon className="size-4" />
          Star
          {stars != null ? (
            <span className="tabular-nums opacity-70">{compactStars.format(stars)}</span>
          ) : null}
        </span>
      </MarketingButton>
    </div>
  );
}
