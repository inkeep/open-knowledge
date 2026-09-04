import { buildLlmsTxt, type LlmsTxtLink } from '@/lib/llms-txt';
import { markdownResponse } from '@/lib/markdown-response';
import { blogPostLinks } from '@/lib/marketing-blog-index';
import { absoluteSiteUrl } from '@/lib/site';
import { source } from '@/lib/source';

export const revalidate = 3600;

export async function GET() {
  const docs: LlmsTxtLink[] = source.getPages().map((page) => ({
    url: absoluteSiteUrl(`${page.url}.md`),
    name: page.data.title,
    description: page.data.description || undefined,
  }));

  return markdownResponse(buildLlmsTxt({ docs, blogPosts: await blogPostLinks(revalidate) }));
}
