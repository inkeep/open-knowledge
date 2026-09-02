import { ImageResponse } from 'next/og';
import {
  BrandCard,
  dmSansFontsArg,
  type FontPair,
  loadDmSans,
  OG_CONTENT_TYPE,
  OG_RESPONSE_HEADERS,
  OG_SIZE,
  ShareCard,
} from '@/lib/og-card';
import { buildSplashViewModel, type SplashView } from '@/lib/share-splash';
import { SITE_NAME } from '@/lib/site';

export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = `Open in ${SITE_NAME}`;

interface OgImageProps {
  params: Promise<{ encoded: string }>;
}

export default async function OgImage({ params }: OgImageProps) {
  const { encoded } = await params;
  const view = buildSplashViewModel(encoded);

  return renderShareOgImage(view, await loadDmSans());
}

export function renderShareOgImage(view: SplashView, fonts: FontPair | null): ImageResponse {
  const body =
    view.kind === 'ok' ? (
      <ShareCard
        filename={view.filename}
        repoPath={view.repoPath}
        branch={view.branch}
        isDefaultBranch={view.isDefaultBranch}
        target={view.target}
      />
    ) : (
      <BrandCard />
    );

  return new ImageResponse(body, {
    ...OG_SIZE,
    fonts: dmSansFontsArg(fonts),
    headers: OG_RESPONSE_HEADERS,
  });
}
