export const dynamic = 'force-dynamic';

export const V1_GUIDE_TARGET = 'https://docs.openknowledge.com/migrate/v0-to-v1';

export function GET(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: V1_GUIDE_TARGET,
      'cache-control': 'public, max-age=300',
    },
  });
}
