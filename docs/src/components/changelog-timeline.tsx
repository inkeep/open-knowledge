import type { ReleaseNote } from '@/lib/releases';
import { CHANGELOG_ROUTE } from '@/lib/site';

/**
 * Vertical release timeline: a sticky version/date rail on the left, notes on the
 * right — the Mintlify `<Update>` treatment. Each version links to its own
 * `/docs/changelog/<tag>` page (the internal link that keeps those pages
 * indexable rather than sitemap-only orphans).
 *
 * `bodyHtml` is trusted: GitHub release notes are authored by maintainers at
 * publish time, the same trust boundary as the docs content itself (cf. the
 * mermaid/katex render sites). It is rendered at build time from the changelog
 * source adapter's GitHub fetch, never fetched in the browser.
 *
 * Deliberately rendered OUTSIDE `DocsBody`: Tailwind Typography's `not-prose`
 * excludes every descendant, so a `not-prose` shell with a nested `prose` notes
 * block cannot re-enable prose. Instead the timeline owns its own chrome and
 * applies `prose` only to the notes.
 */
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
      {/* Left rail: sticky version + date, with the timeline node and connector.
          The connector is drawn on the rail (not the whole row) so it lines up
          with the node at every viewport. */}
      <div className="relative md:sticky md:top-24 md:self-start md:pb-10">
        <div
          aria-hidden="true"
          className="absolute top-2 -right-4 hidden h-full w-px bg-fd-border group-last:hidden md:block"
        />
        <div
          aria-hidden="true"
          className="absolute top-1.5 -right-[1.1875rem] hidden size-2.5 rounded-full border-2 border-fd-background bg-fd-primary md:block"
        />
        {/* The version links to its own /docs/changelog/<tag> page. That internal
            link is what lets search engines discover + index each release's
            standalone page rather than leaving it a sitemap-only orphan. The
            section keeps its `id` (below) so the in-page ToC still anchors to it. */}
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
