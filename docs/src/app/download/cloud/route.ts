import {
  CLOUD_DOWNLOAD_PAGE_PATH,
  cloudTargetById,
  createCloudAssetsResolver,
  PER_VISITOR_CACHE_CONTROL,
  resolveCloudTargetFromParams,
  toRedirectResponse,
} from '@/lib/download-links';
import { attribution, captureServerEvent, isPrefetchRequest, resolveDistinctId } from '@/lib/track';

export const dynamic = 'force-dynamic';

const resolveCloudAsset = createCloudAssetsResolver();

const MAC_DESKTOP = /Macintosh|Mac OS X/;
const APPLE_MOBILE = /iPhone|iPad|iPod/;
const SAFE_UTM_CONTENT = /^[a-z0-9-]{1,64}$/;

function wantsMacDmg(request: Request): boolean {
  const userAgent = request.headers.get('user-agent') ?? '';
  return MAC_DESKTOP.test(userAgent) && !APPLE_MOBILE.test(userAgent);
}

function downloadPageLocation(params: URLSearchParams): string {
  const utmContent = params.get('utm_content');
  if (utmContent && SAFE_UTM_CONTENT.test(utmContent)) {
    return `${CLOUD_DOWNLOAD_PAGE_PATH}?utm_content=${utmContent}`;
  }
  return CLOUD_DOWNLOAD_PAGE_PATH;
}

function downloadPageRedirect(params: URLSearchParams): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: downloadPageLocation(params),
      'cache-control': PER_VISITOR_CACHE_CONTROL,
      vary: 'user-agent',
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const hasExplicitOs = params.has('os');
  const explicitTarget = resolveCloudTargetFromParams(params);

  if (hasExplicitOs && !explicitTarget) {
    return downloadPageRedirect(params);
  }

  if (!explicitTarget && !wantsMacDmg(request)) {
    return downloadPageRedirect(params);
  }

  const target = explicitTarget ?? cloudTargetById('macos-arm64');

  const redirect = await resolveCloudAsset(target.id);
  if (redirect.kind === 'stale-lkg') {
    console.warn(
      `[download/cloud] serving stale LKG after refresh failure: ${redirect.refreshError}`,
    );
  }
  if (redirect.kind === 'fallback') {
    console.error(`[download/cloud] falling back to releases page: ${redirect.cause}`);
  }
  if (redirect.kind !== 'fallback' && !isPrefetchRequest(request)) {
    captureServerEvent({
      event: 'dmg_downloaded',
      distinctId: resolveDistinctId(request),
      properties: {
        channel: 'cloud',
        os: target.os,
        arch: target.arch,
        format: target.format,
        ...attribution(request),
      },
    });
  }
  const response = toRedirectResponse(redirect);
  response.headers.set('cache-control', PER_VISITOR_CACHE_CONTROL);
  if (!explicitTarget) {
    response.headers.set('vary', 'user-agent');
  }
  return response;
}
