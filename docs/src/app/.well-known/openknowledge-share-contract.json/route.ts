import { buildShareContractManifest } from '@/lib/share-contract-manifest';

export const dynamic = 'force-static';

const CACHE_CONTROL = 'public, max-age=0, must-revalidate';

export function GET(): Response {
  return Response.json(buildShareContractManifest(), {
    headers: { 'Cache-Control': CACHE_CONTROL },
  });
}
