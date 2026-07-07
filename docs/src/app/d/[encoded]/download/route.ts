import { NextResponse } from 'next/server';
import { buildPendingShareCookie } from '@/lib/deferred-share';
import { buildSplashViewModel, SPLASH_DOWNLOAD_URL } from '@/lib/share-splash';
import { captureServerEvent, resolveDistinctId } from '@/lib/track';

/**
 * `GET /d/<encoded>/download` — the splash Download CTA target.
 *
 * Sets the pairing cookie carrying `<encoded>` (so the app's first launch can
 * redeem it) and 302s to the unchanged GitHub Releases asset. The DMG itself is
 * untouched — the carry lives entirely in the receiver's browser.
 *
 * The download must NEVER be blocked by the carry: an `<encoded>` that doesn't
 * decode to a valid share still redirects to the asset, just without a cookie.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ encoded: string }> },
): Promise<NextResponse> {
  const { encoded } = await params;
  const response = NextResponse.redirect(SPLASH_DOWNLOAD_URL, 302);

  const view = buildSplashViewModel(encoded);
  if (view.kind === 'ok') {
    response.cookies.set(buildPendingShareCookie(encoded));
  }

  captureServerEvent({
    event: 'dmg_downloaded',
    distinctId: resolveDistinctId(request),
    properties: { channel: 'stable', source: 'share-splash' },
  });

  return response;
}
