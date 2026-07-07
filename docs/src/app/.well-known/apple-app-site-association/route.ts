export const dynamic = 'force-static';

const APPLE_TEAM_ID = '6NZGSG335T';
const APP_BUNDLE_ID = 'com.inkeep.open-knowledge';

// Path-prefix scope `/d/*` is the share-splash route.
// Reserve `/s/*`, `/p/*`, etc. for future share surfaces —
// ADD new entries to `components`, never narrow an existing one: Apple caches
// AASA for 8 days including negative results, so removing a path that was
// previously listed leaves stale receivers intercepting it until cache expiry.
const AASA_MANIFEST = {
  applinks: {
    details: [
      {
        appIDs: [`${APPLE_TEAM_ID}.${APP_BUNDLE_ID}`],
        components: [{ '/': '/d/*', comment: 'Share splash routes' }],
      },
    ],
  },
} as const;

const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';

export function GET() {
  return Response.json(AASA_MANIFEST, {
    headers: { 'Cache-Control': CACHE_CONTROL },
  });
}
