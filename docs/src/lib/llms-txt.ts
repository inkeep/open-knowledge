import {
  MARKETING_MARKDOWN_PAGES,
  type MarketingMarkdownPage,
} from '@/lib/marketing-markdown-pages';
import { escapeInlineProse, markdownLink } from '@/lib/mdx-serializer';
import { absoluteSiteUrl, SITE_DESCRIPTION, SITE_NAME } from '@/lib/site';

export interface LlmsTxtLink {
  readonly url: string;
  readonly name: string;
  readonly description?: string;
}

const LLMS_TXT_SECTIONS = ['Docs', 'Blog', 'Product'] as const;
export type LlmsTxtSection = (typeof LLMS_TXT_SECTIONS)[number];

const PREAMBLE =
  'Every link below is the Markdown rendition of a page. Each rendition names ' +
  'the page a reader would open in its first heading and in its ' +
  '`Link: rel="canonical"` header; that is the URL to cite. Each of those pages ' +
  'also serves this same Markdown from its own URL to any request sending ' +
  '`Accept: text/markdown`.';

function marketingLink(page: MarketingMarkdownPage): LlmsTxtLink {
  return {
    url: absoluteSiteUrl(page.path),
    name: page.name,
    description: page.description,
  };
}

export function marketingLinks(section: LlmsTxtSection): LlmsTxtLink[] {
  return MARKETING_MARKDOWN_PAGES.filter((page) => page.section === section).map(marketingLink);
}

function inline(prose: string, { asLinkLabel = false } = {}): string {
  return escapeInlineProse(prose, { flattenLinks: asLinkLabel });
}

function bullet({ url, name, description }: LlmsTxtLink): string {
  const link = markdownLink(inline(name, { asLinkLabel: true }), url);
  return description ? `- ${link}: ${inline(description)}` : `- ${link}`;
}

function section(name: LlmsTxtSection, links: readonly LlmsTxtLink[]): string[] {
  return links.length === 0 ? [] : [`## ${name}`, links.map(bullet).join('\n')];
}

export function buildLlmsTxt({
  docs,
  blogPosts,
}: {
  docs: readonly LlmsTxtLink[];
  blogPosts: readonly LlmsTxtLink[];
}): string {
  const sections: Record<LlmsTxtSection, readonly LlmsTxtLink[]> = {
    Docs: docs,
    Blog: [...marketingLinks('Blog'), ...blogPosts],
    Product: marketingLinks('Product'),
  };

  return [
    `# ${SITE_NAME}`,
    `> ${SITE_DESCRIPTION}`,
    PREAMBLE,
    ...LLMS_TXT_SECTIONS.flatMap((name) => section(name, sections[name])),
  ].join('\n\n');
}
