import { buildShareContractManifest } from '@/lib/share-contract-manifest';

export const dynamic = 'force-static';

// The share-contract production monitor polls this manifest to detect a
// reader-contract regression, so it must never read a stale copy: max-age=0 +
// must-revalidate forces revalidation on every fetch. (The sibling
// apple-app-site-association manifest is the opposite — it caches aggressively
// because Apple polls it rarely and tolerates staleness.)
const CACHE_CONTROL = 'public, max-age=0, must-revalidate';

export function GET(): Response {
  return Response.json(buildShareContractManifest(), {
    headers: { 'Cache-Control': CACHE_CONTROL },
  });
}
