import type { MetadataRoute } from 'next';
import { BRAND_ROUTE } from '@/lib/brand-assets';
import { getChangelogSource, getReleasePages } from '@/lib/changelog-source';
import { CHANGELOG_ROUTE, SITE_URL } from '@/lib/site';
import { source } from '@/lib/source';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const docPages = source.getPages().map((page) => ({
    url: `${SITE_URL}${page.url}`,
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }));

  // Every stable release gets its own indexable URL here even though the timeline
  // links only to anchors, not to these pages — the sitemap is how search engines
  // discover them. Built from the same build-time changelog source as the pages.
  const changelogSource = await getChangelogSource();
  const releasePages = getReleasePages(changelogSource).map((page) => ({
    url: `${SITE_URL}${page.url}`,
    changeFrequency: 'monthly' as const,
    priority: 0.5,
  }));

  // /sitemap.xml is served by docs (the default zone) — marketing claims only
  // `/` + /marketing-assets/*, so this docs sitemap is the canonical public one
  // and must list the apex (rendered by the marketing zone) plus /brand + docs.
  return [
    { url: SITE_URL, changeFrequency: 'weekly', priority: 1.0 },
    { url: `${SITE_URL}${CHANGELOG_ROUTE}`, changeFrequency: 'weekly', priority: 0.6 },
    ...releasePages,
    { url: `${SITE_URL}${BRAND_ROUTE}`, changeFrequency: 'monthly', priority: 0.4 },
    ...docPages,
  ];
}
