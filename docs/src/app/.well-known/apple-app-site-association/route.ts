export const dynamic = 'force-static';

const APPLE_TEAM_ID = '6NZGSG335T';
const APP_BUNDLE_IDS = ['com.inkeep.open-knowledge', 'com.inkeep.open-knowledge.beta'] as const;

const AASA_MANIFEST = {
  applinks: {
    details: [
      {
        appIDs: APP_BUNDLE_IDS.map((bundleId) => `${APPLE_TEAM_ID}.${bundleId}`),
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
