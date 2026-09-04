export const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';

export const MARKDOWN_CACHE_CONTROL =
  'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';

const MARKDOWN_VARY = 'Accept';

export interface MarkdownResponseInit {
  canonicalUrl?: string;
  status?: number;
}

function markdownHeaders({ canonicalUrl }: MarkdownResponseInit = {}): Headers {
  const headers = new Headers({
    'Content-Type': MARKDOWN_CONTENT_TYPE,
    'Cache-Control': MARKDOWN_CACHE_CONTROL,
    Vary: MARKDOWN_VARY,
  });
  if (canonicalUrl) headers.set('Link', `<${canonicalUrl}>; rel="canonical"`);
  return headers;
}

export function markdownResponse(body: string, init: MarkdownResponseInit = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: markdownHeaders(init) });
}
