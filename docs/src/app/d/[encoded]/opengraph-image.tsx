import { ImageResponse } from 'next/og';
import {
  BrandCard,
  dmSansFontsArg,
  type FontPair,
  loadDmSans,
  OG_CACHE_HEADERS,
  OG_CONTENT_TYPE,
  OG_SIZE,
  ShareCard,
} from '@/lib/og-card';
import { buildSplashViewModel, type SplashView } from '@/lib/share-splash';
import { SITE_NAME } from '@/lib/site';

export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Action-oriented for share pages (vs. the brand headline on the root card),
// but still derives the product name from SITE_NAME.
export const alt = `Open in ${SITE_NAME}`;

interface OgImageProps {
  params: Promise<{ encoded: string }>;
}

export default async function OgImage({ params }: OgImageProps) {
  const { encoded } = await params;
  const view = buildSplashViewModel(encoded);

  return renderShareOgImage(view, await loadDmSans());
}

/**
 * Render the splash OG card. Happy-path views get the bespoke ShareCard
 * (shared eyebrow + filename + repo path); fallback views (invalid /
 * unsupported-version) collapse to the generic BrandCard so the site
 * speaks one visual voice when the share itself can't be rendered.
 *
 * Exported for the co-located test so it can drive the route's image
 * generation without going through Next.js's segment runtime.
 */
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
    headers: OG_CACHE_HEADERS,
  });
}
