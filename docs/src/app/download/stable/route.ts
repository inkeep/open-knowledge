import { resolveTargetFromParams, targetById } from '@/lib/download-targets';
import { attribution, captureServerEvent, isPrefetchRequest, resolveDistinctId } from '@/lib/track';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  const target =
    resolveTargetFromParams(new URL(request.url).searchParams) ?? targetById('macos-arm64');

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
