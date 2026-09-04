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

  const changelogSource = await getChangelogSource();
  const releasePages = getReleasePages(changelogSource).map((page) => ({
    url: `${SITE_URL}${page.url}`,
    changeFrequency: 'monthly' as const,
    priority: 0.5,
  }));

  return [
    { url: SITE_URL, changeFrequency: 'weekly', priority: 1.0 },
    { url: `${SITE_URL}${CHANGELOG_ROUTE}`, changeFrequency: 'weekly', priority: 0.6 },
    ...releasePages,
    { url: `${SITE_URL}${BRAND_ROUTE}`, changeFrequency: 'monthly', priority: 0.4 },
    ...docPages,
  ];
}
