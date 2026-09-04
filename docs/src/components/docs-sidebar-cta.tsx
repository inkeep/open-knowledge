import { DownloadSplitButton } from '@/components/download-split-button';
import { GitHubIcon } from '@/components/icons/github';
import { MarketingButton } from '@/components/marketing-button';
import { GITHUB_URL } from '@/lib/site';

const compactStars = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const fullStars = new Intl.NumberFormat('en-US');

export function DocsSidebarCta({ stars }: { stars: number | null }) {
  return (
    <div className="flex gap-2">
      {}
      {}
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
