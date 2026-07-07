import { SITE_URL } from '@/lib/site';
import { source } from '@/lib/source';

export const revalidate = false;

export async function GET() {
  const pages = source.getPages();
  return new Response(
    [
      '# OpenKnowledge',
      '## Docs',
      // Link to the per-page `.md` so an agent following this index fetches
      // clean Markdown directly instead of the HTML shell. The `…/<slug>.md`
      // route (next.config rewrite → /llms.mdx/[...slug]) serves it.
      ...pages.map((page) => `- [${page.data.title}](${SITE_URL}${page.url}.md)`),
    ].join('\n\n'),
  );
}
