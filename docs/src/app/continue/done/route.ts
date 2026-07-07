import { type NextRequest, NextResponse } from 'next/server';
import { PENDING_SHARE_COOKIE } from '@/lib/deferred-share';

export const dynamic = 'force-dynamic';

/**
 * `GET /continue/done` — the confirmation hop. The desktop's loopback listener
 * redirects the browser here AFTER it has validated the redemption, so this is
 * the single point where the pairing cookie is cleared (single-use semantics)
 * and the branded "you can close this tab" page renders.
 *
 * A route handler (not a page) because clearing a cookie requires a Response.
 */
export function GET(_request: NextRequest): NextResponse {
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>OpenKnowledge</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #faf9f7; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #16151a; color: #f2f1ef; } }
  .card { max-width: 28rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.5rem; font-weight: 500; margin: 0 0 0.75rem; }
  p { margin: 0; line-height: 1.6; opacity: 0.7; font-size: 0.95rem; }
</style>
</head>
<body>
<div class="card" data-testid="continue-done">
<h1>Opening in OpenKnowledge…</h1>
<p>You can close this tab and return to the app.</p>
</div>
</body>
</html>`;

  const response = new NextResponse(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
  response.cookies.delete(PENDING_SHARE_COOKIE);
  return response;
}
