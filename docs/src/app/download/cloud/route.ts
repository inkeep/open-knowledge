import {
  createCloudResolver,
  PER_VISITOR_CACHE_CONTROL,
  RELEASES_PAGE_URL,
  releasePageForAsset,
  toRedirectResponse,
} from '@/lib/download-links';
import { attribution, captureServerEvent, isPrefetchRequest, resolveDistinctId } from '@/lib/track';

export const dynamic = 'force-dynamic';

const resolveCloudRedirect = createCloudResolver();

const MAC_DESKTOP = /Macintosh|Mac OS X/;
const APPLE_MOBILE = /iPhone|iPad|iPod/;

function wantsMacDmg(request: Request): boolean {
  const userAgent = request.headers.get('user-agent') ?? '';
  return MAC_DESKTOP.test(userAgent) && !APPLE_MOBILE.test(userAgent);
}

export async function GET(request: Request): Promise<Response> {
  const redirect = await resolveCloudRedirect();
  if (redirect.kind === 'stale-lkg') {
    console.warn(
      `[download/cloud] serving stale LKG after refresh failure: ${redirect.refreshError}`,
    );
  }
  if (redirect.kind === 'fallback') {
    console.error(`[download/cloud] falling back to releases page: ${redirect.cause}`);
  }
  const macDmg = wantsMacDmg(request);
  const target =
    redirect.kind === 'fallback' || macDmg
      ? redirect
      : { ...redirect, url: releasePageForAsset(redirect.url) ?? RELEASES_PAGE_URL };
  if (redirect.kind !== 'fallback' && macDmg && !isPrefetchRequest(request)) {
    captureServerEvent({
      event: 'dmg_downloaded',
      distinctId: resolveDistinctId(request),
      properties: {
        channel: 'cloud',
        os: 'macos',
        arch: 'arm64',
        format: 'dmg',
        ...attribution(request),
      },
    });
  }
  const response = toRedirectResponse(target);
  response.headers.set('cache-control', PER_VISITOR_CACHE_CONTROL);
  response.headers.set('vary', 'user-agent');
  return response;
}
