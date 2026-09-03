import { getLLMText } from '@/lib/get-llm-text';
import { markdownResponse } from '@/lib/markdown-response';
import { unrenditionedSubtree } from '@/lib/markdown-routes';
import { absoluteSiteUrl, SITE_URL } from '@/lib/site';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

const NOT_FOUND_BODY = `# 404 Not Found

No OpenKnowledge documentation page exists at this URL.

Every published page is listed at <${SITE_URL}/llms.txt>, each with a \`.md\`
rendition of its own.
`;

function noRenditionBody(subtree: string): string {
  return `# 404 Not Found

There is no Markdown rendition under ${subtree}. Those pages are published as
HTML only; read them at <${SITE_URL}${subtree}>.

Every page that does have one is listed at <${SITE_URL}/llms.txt>.
`;
}

interface RouteProps {
  params: Promise<{ slug: string[] }>;
}

export async function GET(_request: Request, props: RouteProps) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) {
    const subtree = unrenditionedSubtree(slug);
    return markdownResponse(subtree ? noRenditionBody(subtree) : NOT_FOUND_BODY, { status: 404 });
  }

  return markdownResponse(await getLLMText(page), {
    canonicalUrl: absoluteSiteUrl(page.url),
  });
}

export function generateStaticParams() {
  return source.generateParams();
}
