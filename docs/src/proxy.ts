import { type NextRequest, NextResponse } from 'next/server';
import { markdownRewrite } from './lib/accept-negotiation';
import { markdownHandlerForPage } from './lib/markdown-routes';

const APEX_HOST = 'openknowledge.ai';
const WWW_HOST = `www.${APEX_HOST}`;
const RESOURCE_PATH =
  /^\/(?:\.well-known|api|d|download|html-preview|ingest|llms\.mdx|og|updates|_next|_vercel)(?:\/|$)/;
const RESOURCE_FILE =
  /\.(?:mdx?|xml|txt|json|svg|png|jpe?g|gif|webp|avif|ico|pdf|woff2?|css|m?js|map|mp4|webm)\/?$/i;

function publicHtmlResponse(request: NextRequest, response: NextResponse): NextResponse {
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    request.headers.get('rsc') !== '1'
  ) {
    response.headers.append(
      'Content-Security-Policy',
      "base-uri 'none'; object-src 'none'; script-src-attr 'none'; frame-ancestors 'none'",
    );
  }
  return response;
}

export function proxy(request: NextRequest): NextResponse {
  const host = (request.headers.get('host') ?? request.nextUrl.host).split(':')[0];
  const pathname = request.nextUrl.pathname;

  if (pathname.startsWith('/.well-known/')) {
    return NextResponse.next();
  }

  if (host === WWW_HOST) {
    const url = request.nextUrl.clone();
    url.hostname = APEX_HOST;
    return NextResponse.redirect(url, 308);
  }

  const handler = markdownHandlerForPage(pathname);
  const negotiated = markdownRewrite(request, handler);
  if (negotiated) return negotiated;

  const response = NextResponse.next();
  return RESOURCE_PATH.test(pathname) || RESOURCE_FILE.test(pathname)
    ? response
    : publicHtmlResponse(request, response);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
