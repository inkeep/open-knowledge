import { DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import type { Metadata } from 'next';
import { ChangelogTimeline } from '@/components/changelog-timeline';
import { getChangelogSource } from '@/lib/changelog-source';
import { CHANGELOG_ROUTE, metaDescription, SITE_NAME, SITE_URL } from '@/lib/site';

export const dynamic = 'force-static';

const PAGE_TITLE = 'Changelog';
const PAGE_DESCRIPTION = `Release notes for ${SITE_NAME}.`;
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
  const source = await getChangelogSource();
  const releases = source.getPage([])?.data.releases ?? [];

  const toc = releases.map((release) => ({
    title: release.title,
    url: `#${release.tag}`,
    depth: 2,
  }));

  return (
    <DocsPage toc={toc} tableOfContent={{ style: 'clerk' }} article={{ className: 'pb-12' }}>
      <DocsTitle>{PAGE_TITLE}</DocsTitle>
      <DocsDescription>{PAGE_DESCRIPTION}</DocsDescription>
      {}
      <ChangelogTimeline releases={releases} />
    </DocsPage>
  );
}
