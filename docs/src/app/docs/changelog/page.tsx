import { DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import type { Metadata } from 'next';
import { ChangelogTimeline } from '@/components/changelog-timeline';
import { getChangelogSource } from '@/lib/changelog-source';
import {
  CHANGELOG_ROUTE,
  metaDescription,
  RELEASES_PAGE_URL,
  SITE_NAME,
  SITE_URL,
} from '@/lib/site';

/**
 * `/docs/changelog` — the stable release notes.
 *
 * Data comes from the Fumadocs changelog source adapter (`getChangelogSource`),
 * which reads packages/cli/CHANGELOG.md at build time (dates come from a small
 * best-effort GitHub call). `dynamic = 'force-static'` makes that happen once during
 * the build and bakes the result into static HTML — fully indexable, no runtime
 * dependency. A stable release refreshes it because the `main-reset` commit that
 * rewrites CHANGELOG.md triggers a docs rebuild (see
 * `public-open-knowledge-docs-changelog-deploy.yml`). Living under `app/docs/` puts
 * the page inside the shared `DocsLayout` (sidebar + search); this static segment
 * takes precedence over the `[...slug]` MDX catch-all.
 */
export const dynamic = 'force-static';

const PAGE_TITLE = 'Changelog';
const PAGE_DESCRIPTION = `Stable releases of ${SITE_NAME}, newest first, with the notes for every version.`;
const RSS_ROUTE = `${CHANGELOG_ROUTE}/rss.xml`;

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: metaDescription(PAGE_DESCRIPTION),
  alternates: {
    canonical: `${SITE_URL}${CHANGELOG_ROUTE}`,
    types: { 'application/rss+xml': `${SITE_URL}${RSS_ROUTE}` },
  },
  openGraph: {
    title: `${PAGE_TITLE} · ${SITE_NAME}`,
    description: metaDescription(PAGE_DESCRIPTION),
    url: `${SITE_URL}${CHANGELOG_ROUTE}`,
  },
};

export default async function ChangelogPage() {
  // `getChangelogSource` parses CHANGELOG.md at build time. In a normal deploy the
  // file is present so `releases` is populated; in the public mirror (CHANGELOG.md
  // excluded) it resolves empty and the timeline just renders nothing.
  const source = await getChangelogSource();
  const releases = source.getPage([])?.data.releases ?? [];

  // Anchors mirror the timeline's per-release section ids.
  const toc = releases.map((release) => ({
    title: release.title,
    url: `#${release.tag}`,
    depth: 2,
  }));

  return (
    <DocsPage toc={toc} tableOfContent={{ style: 'clerk' }} article={{ className: 'pb-12' }}>
      <DocsTitle>{PAGE_TITLE}</DocsTitle>
      <DocsDescription>
        Stable releases, newest first, with notes for every version. Also published on{' '}
        <a href={RELEASES_PAGE_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        .
      </DocsDescription>
      {/* Outside DocsBody on purpose — the timeline owns its own chrome and
          scopes `prose` to the notes (see ChangelogTimeline). */}
      <ChangelogTimeline releases={releases} />
    </DocsPage>
  );
}
