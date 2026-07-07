import { createBetaResolver, toRedirectResponse } from '@/lib/download-links';
import { captureServerEvent, referrerHostname, resolveDistinctId } from '@/lib/track';

/**
 * Perennial beta-channel download URL: openknowledge.ai/download/beta
 * 302s to the newest published `-beta.N` DMG on inkeep/open-knowledge,
 * degrading to the releases page when resolution fails (never an error
 * page — shared links must land somewhere actionable).
 *
 * force-dynamic keeps `next build` from prerendering this route, which
 * would freeze the redirect target at deploy time and make builds depend
 * on api.github.com availability. Caching is handled explicitly in
 * download-links.ts (see createBetaResolver) because force-dynamic also
 * forces every fetch to no-store, silently disabling `next.revalidate`.
 */
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
  // A fallback sends the user to the releases page, not a DMG — don't count it.
  if (redirect.kind !== 'fallback') {
    captureServerEvent({
      event: 'dmg_downloaded',
      distinctId: resolveDistinctId(request),
      properties: { channel: 'beta', referrer: referrerHostname(request) },
    });
  }
  return toRedirectResponse(redirect);
}
