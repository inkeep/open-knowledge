import { getChangelogSource } from '@/lib/changelog-source';
import { CHANGELOG_ROUTE, SITE_NAME, SITE_URL } from '@/lib/site';

export const dynamic = 'force-static';

const FEED_URL = `${SITE_URL}${CHANGELOG_ROUTE}/rss.xml`;
const PAGE_URL = `${SITE_URL}${CHANGELOG_ROUTE}`;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(html: string): string {
  return `<![CDATA[${html.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function rfc822(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toUTCString();
}

export async function GET(): Promise<Response> {
  const source = await getChangelogSource();
  const releases = source.getPage([])?.data.releases ?? [];
  const items = releases
    .map((release) => {
      const pubDate = rfc822(release.publishedAt);
      return [
        '    <item>',
        `      <title>${escapeXml(release.title)}</title>`,
        `      <link>${escapeXml(release.htmlUrl)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(release.htmlUrl)}</guid>`,
        pubDate ? `      <pubDate>${pubDate}</pubDate>` : null,
        `      <description>${cdata(release.bodyHtml)}</description>`,
        '    </item>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(`${SITE_NAME} Changelog`)}</title>
    <link>${PAGE_URL}</link>
    <description>${escapeXml(`Stable releases of ${SITE_NAME}.`)}</description>
    <language>en</language>
    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
  });
}
