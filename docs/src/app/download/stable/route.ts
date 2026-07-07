import { STABLE_DMG_URL } from '@/lib/download-links';
import { captureServerEvent, referrerHostname, resolveDistinctId } from '@/lib/track';

/**
 * Perennial stable-channel download URL: openknowledge.ai/download/stable
 * Constant 302 to GitHub's `releases/latest` alias — GitHub resolves the
 * newest stable at request time, so no API call or state is needed here.
 * `force-dynamic` keeps Next.js from prerendering the 302 and keeps request
 * headers live per request.
 *
 * Served `no-store` rather than CDN-cached: counting every download means the
 * function must run on each click, so the redirect can't be cached at the edge
 * the way the permanent alias otherwise would be.
 */
export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  captureServerEvent({
    event: 'dmg_downloaded',
    distinctId: resolveDistinctId(request),
    properties: { channel: 'stable', referrer: referrerHostname(request) },
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: STABLE_DMG_URL,
      'cache-control': 'no-store',
    },
  });
}
