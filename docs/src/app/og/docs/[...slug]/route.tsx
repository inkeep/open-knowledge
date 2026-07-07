import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import {
  DocPageCard,
  dmSansFontsArg,
  loadDmSans,
  OG_CACHE_HEADERS,
  OG_CONTENT_TYPE,
  OG_SIZE,
} from '@/lib/og-card';
import { source } from '@/lib/source';

/**
 * Per-docs-page OpenGraph image. Mounted here (not as a file-based
 * `opengraph-image.tsx` co-located with the page) because Turbopack
 * rejects metadata files nested inside catch-all `[...slug]` segments
 * ("catch-all segment must be the last segment modifying the path"). A
 * route handler whose own catch-all IS the last segment sidesteps that
 * constraint; the page's `generateMetadata` references this URL in its
 * `openGraph.images` array.
 */
export const dynamic = 'force-static';

interface RouteProps {
  params: Promise<{ slug: string[] }>;
}

export async function GET(_request: Request, props: RouteProps) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const fonts = await loadDmSans();
  return new ImageResponse(
    <DocPageCard title={page.data.title} description={page.data.description} />,
    {
      ...OG_SIZE,
      fonts: dmSansFontsArg(fonts),
      headers: { ...OG_CACHE_HEADERS, 'Content-Type': OG_CONTENT_TYPE },
    },
  );
}

export function generateStaticParams() {
  return source.generateParams();
}
