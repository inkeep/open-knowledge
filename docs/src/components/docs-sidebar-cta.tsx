import { DownloadSplitButton } from '@/components/download-split-button';
import { GitHubIcon } from '@/components/icons/github';
import { MarketingButton } from '@/components/marketing-button';
import { GITHUB_URL } from '@/lib/site';

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
      {/* Docs readers span platforms, so the primary segment follows the
          visitor's OS and the caret carries the rest. Unlike the old plain link
          to /download, this routes through the tracked redirect, so sidebar
          downloads are attributed rather than invisible. */}
      {/* The download flexes and the star keeps its natural size: the star's
          width is driven by a live count we don't control, so it gets the space
          it needs and the download absorbs whatever is left. */}
      <DownloadSplitButton cta="docs-sidebar" variant="compact" className="min-w-0 flex-1" />
      <MarketingButton
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Star on GitHub"
        title={stars != null ? `${fullStars.format(stars)} GitHub stars` : 'Star on GitHub'}
        variant="outline"
        size="sm"
        className="h-8 shrink-0 justify-center gap-2 rounded-lg px-3 uppercase tracking-[-0.64px] text-sm sm:text-sm border-border bg-fd-secondary text-fd-secondary-foreground hover:bg-fd-accent hover:text-fd-accent-foreground"
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
