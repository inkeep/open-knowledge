import type { MetadataRoute } from 'next';
import { BRAND_ROUTE } from '@/lib/brand-assets';
import { SITE_URL } from '@/lib/site';
import { source } from '@/lib/source';

export default function sitemap(): MetadataRoute.Sitemap {
  const docPages = source.getPages().map((page) => ({
    url: `${SITE_URL}${page.url}`,
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }));

  // /sitemap.xml is served by docs (the default zone) — marketing claims only
  // `/` + /marketing-assets/*, so this docs sitemap is the canonical public one
  // and must list the apex (rendered by the marketing zone) plus /brand + docs.
  return [
    { url: SITE_URL, changeFrequency: 'weekly', priority: 1.0 },
    { url: `${SITE_URL}${BRAND_ROUTE}`, changeFrequency: 'monthly', priority: 0.4 },
    ...docPages,
  ];
}
