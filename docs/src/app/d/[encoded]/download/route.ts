import { NextResponse } from 'next/server';
import { buildPendingShareCookie } from '@/lib/deferred-share';
import { DOWNLOAD_PAGE_HREF, resolveTargetFromParams, targetById } from '@/lib/download-targets';
import { buildSplashViewModel } from '@/lib/share-splash';
import { attribution, captureServerEvent, isPrefetchRequest, resolveDistinctId } from '@/lib/track';

/**
 * `GET /d/<encoded>/download` — the splash Download CTA target.
 *
 * Sets the pairing cookie carrying `<encoded>` (so the app's first launch can
 * redeem it) and 302s to the release asset named by `?os=&arch=&format=`.
 * A query-less detected Windows/Linux click sets the cookie and continues to
 * the architecture picker instead. The assets are untouched — the carry lives
 * entirely in the receiver's browser, so it works the same on every platform.
 * That is why every concrete platform row points back here rather than at
 * `/download/stable` or GitHub: any other target drops the share.
 *
 * The download must NEVER be blocked by the carry: an `<encoded>` that doesn't
 * decode to a valid share still redirects to the asset, just without a cookie.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ encoded: string }> },
): Promise<NextResponse> {
  const { encoded } = await params;
  const searchParams = new URL(request.url).searchParams;
  const target = resolveTargetFromParams(searchParams);
  const view = buildSplashViewModel(encoded);

  // A detected Windows/Linux primary click reaches here with `picker=1` but no
  // build triple. Preserve the pending share before sending the recipient to
  // the architecture picker; explicit caret rows still name a concrete target.
  if (searchParams.get('picker') === '1') {
    const response = NextResponse.redirect(`${DOWNLOAD_PAGE_HREF}?utm_content=share-splash`, 302);
    if (view.kind === 'ok') response.cookies.set(buildPendingShareCookie(encoded));
    return response;
  }

  // Legacy/no-JS links omit the triple and retain the historical macOS floor.
  const selectedTarget = target ?? targetById('macos-arm64');
  const response = NextResponse.redirect(selectedTarget.assetUrl, 302);

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
        os: selectedTarget.os,
        arch: selectedTarget.arch,
        format: selectedTarget.format,
        ...attribution(request),
        utm_content: 'share-splash',
      },
    });
  }

  return response;
}
