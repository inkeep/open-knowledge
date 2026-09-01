import { createBetaResolver, toRedirectResponse } from '@/lib/download-links';
import { attribution, captureServerEvent, isPrefetchRequest, resolveDistinctId } from '@/lib/track';

export const dynamic = 'force-dynamic';

const resolveBetaRedirect = createBetaResolver();

export async function GET(request: Request): Promise<Response> {
  const redirect = await resolveBetaRedirect();
  if (redirect.kind === 'stale-lkg') {
    console.warn(
      `[download/beta] serving stale LKG after refresh failure: ${redirect.refreshError}`,
    );
  }
  if (redirect.kind === 'fallback') {
    console.error(`[download/beta] falling back to releases page: ${redirect.cause}`);
  }
  if (redirect.kind !== 'fallback' && !isPrefetchRequest(request)) {
    captureServerEvent({
      event: 'dmg_downloaded',
      distinctId: resolveDistinctId(request),
      properties: {
        channel: 'beta',
        os: 'macos',
        arch: 'arm64',
        format: 'dmg',
        ...attribution(request),
      },
    });
  }
  return toRedirectResponse(redirect);
}
