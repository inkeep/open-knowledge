import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import {
  DocPageCard,
  dmSansFontsArg,
  loadDmSans,
  OG_CONTENT_TYPE,
  OG_RESPONSE_HEADERS,
  OG_SIZE,
} from '@/lib/og-card';
import { source } from '@/lib/source';

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
      headers: { ...OG_RESPONSE_HEADERS, 'Content-Type': OG_CONTENT_TYPE },
    },
  );
}

export function generateStaticParams() {
  return source.generateParams();
}
