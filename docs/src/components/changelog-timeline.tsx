import type { ReleaseNote } from '@/lib/releases';
import { CHANGELOG_ROUTE } from '@/lib/site';

export function ChangelogTimeline({ releases }: { releases: ReleaseNote[] }) {
  return (
    <div className="flex flex-col">
      {releases.map((release) => (
        <ChangelogEntry key={release.tag} release={release} />
      ))}
    </div>
  );
}

function ChangelogEntry({ release }: { release: ReleaseNote }) {
  const date = formatDate(release.publishedAt);

  return (
    <section
      id={release.tag}
      className="group relative scroll-mt-24 pb-10 md:grid md:grid-cols-[10rem_1fr] md:gap-8"
    >
      {}
      <div className="relative md:sticky md:top-24 md:self-start md:pb-10">
        <div
          aria-hidden="true"
          className="absolute top-2 -right-4 hidden h-full w-px bg-fd-border group-last:hidden md:block"
        />
        <div
          aria-hidden="true"
          className="absolute top-1.5 -right-[1.1875rem] hidden size-2.5 rounded-full border-2 border-fd-background bg-fd-primary md:block"
        />
        {}
        <a
          href={`${CHANGELOG_ROUTE}/${release.tag}`}
          className="font-mono text-sm font-medium text-fd-foreground no-underline transition-colors hover:text-fd-primary"
        >
          {release.title}
        </a>
        {date ? (
          <time
            dateTime={release.publishedAt ?? undefined}
            className="mt-1 block text-xs text-fd-muted-foreground"
          >
            {date}
          </time>
        ) : null}
      </div>

      <div className="mt-3 min-w-0 md:mt-0">
        {release.bodyHtml ? (
          <div
            className="prose max-w-none prose-headings:mt-6 prose-headings:mb-2 first:prose-headings:mt-0"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted maintainer-authored release notes, rendered at build time
            dangerouslySetInnerHTML={{ __html: release.bodyHtml }}
          />
        ) : (
          <p className="text-sm text-fd-muted-foreground">No notes for this release.</p>
        )}
        <a
          href={release.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-block text-xs text-fd-muted-foreground underline underline-offset-4 transition-colors hover:text-fd-foreground"
        >
          View on GitHub
        </a>
      </div>
    </section>
  );
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(ms);
}
