import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/d/'],
      },
    ],
    // The marketing zone owns /blog/:path* on the apex and serves its own
    // sitemap for the blog posts this app can't enumerate.
    sitemap: [
      `${SITE_URL}/sitemap.xml`,
      `${SITE_URL}/blog/sitemap.xml`,
      `${SITE_URL}/team/sitemap.xml`,
    ],
  };
}
