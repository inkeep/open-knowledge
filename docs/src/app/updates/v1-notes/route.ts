export const dynamic = 'force-dynamic';

export const V1_NOTES_TARGET = 'https://openknowledge.ai/docs/changelog';

export function GET(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: V1_NOTES_TARGET,
      'cache-control': 'public, max-age=300',
    },
  });
}
