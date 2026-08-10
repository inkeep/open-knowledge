import { NextResponse } from 'next/server';
import { buildPendingShareCookie } from '@/lib/deferred-share';
import { resolveTargetFromParams, targetById } from '@/lib/download-targets';
import { buildSplashViewModel } from '@/lib/share-splash';
import { attribution, captureServerEvent, isPrefetchRequest, resolveDistinctId } from '@/lib/track';

/**
 * `GET /d/<encoded>/download` — the splash Download CTA target.
 *
 * Sets the pairing cookie carrying `<encoded>` (so the app's first launch can
 * redeem it) and 302s to the release asset named by `?os=&arch=&format=`,
 * defaulting to the macOS DMG. The assets are untouched — the carry lives
 * entirely in the receiver's browser, so it works the same on every platform.
 * That is why the splash's platform picker points every row back here rather
 * than at `/download/stable` or GitHub: any other target drops the share.
 *
 * The download must NEVER be blocked by the carry: an `<encoded>` that doesn't
 * decode to a valid share still redirects to the asset, just without a cookie.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ encoded: string }> },
): Promise<NextResponse> {
  const { encoded } = await params;
  const target =
    resolveTargetFromParams(new URL(request.url).searchParams) ?? targetById('macos-arm64');
  const response = NextResponse.redirect(target.assetUrl, 302);

  const view = buildSplashViewModel(encoded);
  if (view.kind === 'ok') {
    response.cookies.set(buildPendingShareCookie(encoded));
  }

  // A prefetch is not a download — redirect it, don't count it. `utm_content`
  // is server-authoritative here (this route IS the share-splash CTA), so it
  // wins over any `?utm_content=` on the request.
  if (!isPrefetchRequest(request)) {
    captureServerEvent({
      event: 'dmg_downloaded',
      distinctId: resolveDistinctId(request),
      properties: {
        channel: 'stable',
        os: target.os,
        arch: target.arch,
        format: target.format,
        ...attribution(request),
        utm_content: 'share-splash',
      },
    });
  }

  return response;
}
