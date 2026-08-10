import { resolveTargetFromParams, targetById } from '@/lib/download-targets';
import { attribution, captureServerEvent, isPrefetchRequest, resolveDistinctId } from '@/lib/track';

/**
 * Perennial stable-channel download URL: openknowledge.ai/download/stable
 * 302s to GitHub's `releases/latest` alias — GitHub resolves the newest stable
 * at request time, so no API call or state is needed here.
 *
 * `?os=&arch=&format=` selects which build; omitting them keeps the historical
 * macOS DMG behavior, which every pre-picker link in the wild relies on.
 * `force-dynamic` keeps Next.js from prerendering the 302 and keeps request
 * headers live per request.
 *
 * Served `no-store` rather than CDN-cached: counting every download means the
 * function must run on each click, so the redirect can't be cached at the edge
 * the way the permanent alias otherwise would be.
 */
export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  const target =
    resolveTargetFromParams(new URL(request.url).searchParams) ?? targetById('macos-arm64');

  // A prefetch is not a download — redirect it, don't count it.
  if (!isPrefetchRequest(request)) {
    captureServerEvent({
      event: 'dmg_downloaded',
      distinctId: resolveDistinctId(request),
      properties: {
        channel: 'stable',
        // The event name predates every non-macOS build and is analytics
        // lineage; these three are what dashboards should slice on instead.
        os: target.os,
        arch: target.arch,
        format: target.format,
        ...attribution(request),
      },
    });
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: target.assetUrl,
      'cache-control': 'no-store',
    },
  });
}
