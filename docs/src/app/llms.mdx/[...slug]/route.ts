import { notFound } from 'next/navigation';
import { getLLMText } from '@/lib/get-llm-text';
import { source } from '@/lib/source';

/**
 * Per-page raw Markdown for agent / LLM consumption. Reachable at the
 * conventional `…/<slug>.md` URL: `next.config.ts` rewrites `/docs/:path*.md`
 * (and `.mdx`) to this handler, which mirrors the catch-all shape of the OG
 * route (`/og/docs/[...slug]`). Each page is served as `text/markdown` so an
 * agent can fetch a single page (~few KB) instead of parsing the HTML shell or
 * downloading the whole `llms-full.txt` corpus.
 */
export const dynamic = 'force-static';

interface RouteProps {
  params: Promise<{ slug: string[] }>;
}

export async function GET(_request: Request, props: RouteProps) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}

export function generateStaticParams() {
  return source.generateParams();
}
