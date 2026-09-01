import { type NextRequest, NextResponse } from 'next/server';

const APEX_HOST = 'openknowledge.ai';
const WWW_HOST = `www.${APEX_HOST}`;

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
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
