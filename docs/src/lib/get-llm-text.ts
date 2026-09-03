import type { InferPageType } from 'fumadocs-core/source';
import { escapeInlineProse, escapeRawHtml, serializeMdx } from '@/lib/mdx-serializer';
import { DOCS_SERIALIZER_REGISTRY } from '@/lib/mdx-serializer-registry';
import { absoluteSiteUrl } from '@/lib/site';
import type { source } from '@/lib/source';

export async function getLLMText(page: InferPageType<typeof source>): Promise<string> {
  const canonicalUrl = absoluteSiteUrl(page.url);
  const mdx = await page.data.getText('raw');
  const { body } = serializeMdx(mdx, {
    registry: DOCS_SERIALIZER_REGISTRY,
    pageUrl: canonicalUrl,
  });

  return `# ${escapeInlineProse(page.data.title)} (${canonicalUrl})

${escapeRawHtml(page.data.description || '')}

${body}`;
}
