import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getChangelogSource, getReleasePages } from '@/lib/changelog-source';
import { CHANGELOG_ROUTE, metaDescription, SITE_NAME, SITE_URL } from '@/lib/site';

/**
 * `/docs/changelog/<tag>` — one indexable page per stable release.
 *
 * These pages exist for search-engine indexing: every release gets its own URL in
 * the sitemap even though the timeline at `/docs/changelog` links only to anchors,
 * not to these pages. Data comes from the same build-time changelog source adapter;
 * `dynamic = 'force-static'` + `dynamicParams = false` prerender exactly the known
 * tags as static HTML and 404 anything else (so the sibling `rss.xml` route is
 * never shadowed).
 */
export const dynamic = 'force-static';
export const dynamicParams = false;

export async function generateStaticParams() {
  const source = await getChangelogSource();
  return getReleasePages(source).map((page) => ({ tag: page.slugs[0] }));
}

export async function generateMetadata(
  props: PageProps<'/docs/changelog/[tag]'>,
): Promise<Metadata> {
  const { tag } = await props.params;
  const source = await getChangelogSource();
  const release = source.getPage([tag])?.data.releases[0];
  if (!release) notFound();

  const url = `${CHANGELOG_ROUTE}/${tag}`;
  const description = metaDescription(
    `Release notes for ${SITE_NAME} ${release.tag}${
      release.publishedAt ? `, published ${formatDate(release.publishedAt)}` : ''
    }.`,
  );

  return {
    title: `${release.title} · Changelog`,
    description,
    alternates: { canonical: `${SITE_URL}${url}` },
    openGraph: {
      type: 'article',
      siteName: SITE_NAME,
      title: `${release.title} · ${SITE_NAME} Changelog`,
      description,
      url: `${SITE_URL}${url}`,
    },
  };
}

export default async function ReleasePage(props: PageProps<'/docs/changelog/[tag]'>) {
  const { tag } = await props.params;
  const source = await getChangelogSource();
  const release = source.getPage([tag])?.data.releases[0];
  if (!release) notFound();

  const date = formatDate(release.publishedAt);

  return (
    <DocsPage article={{ className: 'pb-12' }}>
      <DocsTitle>{release.title}</DocsTitle>
      <DocsDescription>
        {date ? `Released ${date}. ` : ''}
        Part of the <a href={CHANGELOG_ROUTE}>{SITE_NAME} changelog</a>.
      </DocsDescription>
      <DocsBody>
        {release.bodyHtml ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted maintainer-authored release notes, rendered at build time
          <div dangerouslySetInnerHTML={{ __html: release.bodyHtml }} />
        ) : (
          <p>No notes for this release.</p>
        )}
        <p>
          <a href={release.htmlUrl} target="_blank" rel="noreferrer">
            View {release.tag} on GitHub
          </a>
        </p>
      </DocsBody>
    </DocsPage>
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
