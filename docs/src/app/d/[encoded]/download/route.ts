import { NextResponse } from 'next/server';
import { buildPendingShareCookie } from '@/lib/deferred-share';
import { DOWNLOAD_PAGE_HREF, resolveTargetFromParams, targetById } from '@/lib/download-targets';
import { buildSplashViewModel } from '@/lib/share-splash';
import { attribution, captureServerEvent, isPrefetchRequest, resolveDistinctId } from '@/lib/track';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ encoded: string }> },
): Promise<NextResponse> {
  const { encoded } = await params;
  const searchParams = new URL(request.url).searchParams;
  const target = resolveTargetFromParams(searchParams);
  const view = buildSplashViewModel(encoded);

  if (searchParams.get('picker') === '1') {
    const response = NextResponse.redirect(`${DOWNLOAD_PAGE_HREF}?utm_content=share-splash`, 302);
    if (view.kind === 'ok') response.cookies.set(buildPendingShareCookie(encoded));
    return response;
  }

  const selectedTarget = target ?? targetById('macos-arm64');
  const response = NextResponse.redirect(selectedTarget.assetUrl, 302);

  if (view.kind === 'ok') {
    response.cookies.set(buildPendingShareCookie(encoded));
  }

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
