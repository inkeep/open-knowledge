import { SITE_URL } from '@/lib/site';
import { source } from '@/lib/source';

export const revalidate = false;

export async function GET() {
  const pages = source.getPages();
  return new Response(
    [
      '# OpenKnowledge',
      '## Docs',
      ...pages.map((page) => `- [${page.data.title}](${SITE_URL}${page.url}.md)`),
    ].join('\n\n'),
  );
}
