import { type NextRequest, NextResponse } from 'next/server';

const APEX_HOST = 'openknowledge.ai';
const WWW_HOST = `www.${APEX_HOST}`;

/**
 * Canonicalize `www.openknowledge.ai` -> `openknowledge.ai`, EXCEPT for
 * `/.well-known/*`.
 *
 * The desktop entitlement declares Universal Links for both `applinks:openknowledge.ai`
 * and `applinks:www.openknowledge.ai`, so BOTH hosts must serve
 * `/.well-known/apple-app-site-association` as a direct 200. Apple's `swcd`
 * fetches the AASA without following redirects and negative-caches a failure
 * for ~8 days, so any redirect on the www AASA path silently breaks
 * Universal-Link auto-open for every share link on www.
 *
 * This carve-out lives in the request body (not only the `matcher`) so it is
 * the single, unit-tested source of truth — the entire `/.well-known/*` prefix
 * passes through untouched while every other www URL is canonicalized to apex
 * with a permanent (308) redirect.
 */
export function proxy(request: NextRequest): NextResponse {
  const host = (request.headers.get('host') ?? request.nextUrl.host).split(':')[0];

  if (request.nextUrl.pathname.startsWith('/.well-known/')) {
    return NextResponse.next();
  }

  if (host === WWW_HOST) {
    const url = request.nextUrl.clone();
    url.hostname = APEX_HOST;
    return NextResponse.redirect(url, 308);
  }

  return NextResponse.next();
}

export const config = {
  // Run on every request except Next.js internals and static assets. The
  // `/.well-known/*` carve-out is enforced in the body above, not here, so it
  // stays covered by proxy.test.ts.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
