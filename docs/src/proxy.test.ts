import { NextRequest } from 'next/server';
import { describe, expect, test, vi } from 'vitest';
import { proxy } from './proxy.ts';

function run(host: string, pathAndQuery: string) {
  const req = new NextRequest(`https://${host}${pathAndQuery}`, { headers: { host } });
  return proxy(req);
}

const APEX = 'openknowledge.ai';
const WWW = 'www.openknowledge.ai';
const AASA = '/.well-known/apple-app-site-association';

describe('proxy: www -> apex canonicalization', () => {
  test('www + AASA passes through (no redirect) so Apple gets a direct 200', () => {
    const res = run(WWW, AASA);
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });

  test('the whole /.well-known/* prefix is excluded on www, not just AASA', () => {
    const res = run(WWW, '/.well-known/assetlinks.json');
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });

  test('www + a normal page redirects 308 to apex', () => {
    const res = run(WWW, '/docs/get-started/quickstart');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`https://${APEX}/docs/get-started/quickstart`);
  });

  test('www + root redirects 308 to apex root', () => {
    const res = run(WWW, '/');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`https://${APEX}/`);
  });

  test('www redirect preserves the query string', () => {
    const res = run(WWW, '/d/abc123?ref=slack');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`https://${APEX}/d/abc123?ref=slack`);
  });

  test('apex + a normal page is untouched (no redirect)', () => {
    const res = run(APEX, '/docs/get-started/quickstart');
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });

  test('apex + AASA is untouched (the working host stays working)', () => {
    const res = run(APEX, AASA);
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });

  test('preview/other hosts are not canonicalized to apex', () => {
    const res = run('open-knowledge-git-feat.vercel.app', '/docs');
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });
});

function negotiate(pathAndQuery: string, accept?: string) {
  const headers: Record<string, string> = { host: APEX };
  if (accept !== undefined) headers.accept = accept;
  const res = proxy(new NextRequest(`https://${APEX}${pathAndQuery}`, { headers }));
  const rewrite = res.headers.get('x-middleware-rewrite');
  return {
    status: res.status,
    location: res.headers.get('location'),
    rewrittenTo: rewrite ? new URL(rewrite).pathname : null,
  };
}

const MARKDOWN = 'text/markdown';
const BROWSER_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

describe('public HTML policy', () => {
  function policy(path: string, headers?: HeadersInit) {
    return proxy(new NextRequest(`https://${APEX}${path}`, { headers })).headers.get(
      'content-security-policy',
    );
  }

  test.each([
    '/docs/get-started/quickstart',
    '/docs/changelog/v0.4.0',
    '/continue',
    '/continue/done',
    '/unknown-path',
  ])('protects %s', (path) => {
    expect(policy(path, { accept: BROWSER_ACCEPT })).toBe(
      "base-uri 'none'; object-src 'none'; script-src-attr 'none'; frame-ancestors 'none'",
    );
  });

  test('does not change the negotiated Markdown or Next data', () => {
    expect(policy('/docs/overview', { accept: MARKDOWN })).toBeNull();
    expect(policy('/docs/overview?_rsc=next', { rsc: '1' })).toBeNull();
  });

  test.each([
    '/docs/changelog/rss.xml',
    '/docs/overview.md',
    '/api/search',
    '/d/abc123',
    '/d/abc123/download',
    '/download/stable',
    '/html-preview/example',
    '/ingest/decide',
    '/llms.mdx/overview',
    '/og/docs/overview',
    '/updates/stable/example.yml',
    '/images/overview.png',
  ])('does not change %s', (path) => expect(policy(path)).toBeNull());
});

describe('public connection policy', () => {
  const enforced = 'content-security-policy';
  const reporting = 'content-security-policy-report-only';
  const connect = "connect-src 'self' https://api.inkeep.com https://api.io.inkeep.com";

  test('reports on HTML with only the exact search destinations and self', () => {
    const page = run(APEX, '/docs/get-started/quickstart');
    expect(page.headers.get(reporting)).toBe(connect);
    expect(page.headers.get(enforced)).not.toContain('connect-src');
    expect(run(APEX, '/continue').headers.get(reporting)).toBe(connect);
    expect(run(APEX, '/d/example').headers.get(reporting)).toBeNull();
    expect(run(APEX, '/html-preview/example').headers.get(reporting)).toBeNull();
    expect(run(APEX, '/api/search').headers.get(reporting)).toBeNull();
  });

  test('enforcement also preserves the baseline in the same policy', () => {
    vi.stubEnv('OK_PUBLIC_CONNECT_CSP_MODE', 'enforce');
    try {
      const page = run(APEX, '/docs/get-started/quickstart');
      expect(page.headers.get(enforced)).toBe(
        `base-uri 'none'; object-src 'none'; script-src-attr 'none'; frame-ancestors 'none'; ${connect}`,
      );
      expect(page.headers.get(reporting)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('proxy: Accept negotiation', () => {
  test('a docs page requested as Markdown serves its Markdown rendition', () => {
    expect(negotiate('/docs/get-started/quickstart', MARKDOWN).rewrittenTo).toBe(
      '/llms.mdx/get-started/quickstart',
    );
  });

  test('a one-segment slug resolves too', () => {
    expect(negotiate('/docs/overview', MARKDOWN).rewrittenTo).toBe('/llms.mdx/overview');
  });

  test('a trailing slash still resolves', () => {
    expect(negotiate('/docs/overview/', MARKDOWN).rewrittenTo).toBe('/llms.mdx/overview');
  });

  test('the query string survives the rewrite', () => {
    const res = negotiate('/docs/overview?ref=agent', MARKDOWN);
    expect(res.rewrittenTo).toBe('/llms.mdx/overview');
  });

  test('a browser gets the page untouched', () => {
    const res = negotiate('/docs/get-started/quickstart', BROWSER_ACCEPT);
    expect(res.rewrittenTo).toBeNull();
    expect(res.status).toBe(200);
  });

  test('a request with no Accept gets the page', () => {
    expect(negotiate('/docs/overview').rewrittenTo).toBeNull();
  });

  test('negotiation rewrites rather than redirecting, so the URL stays shareable', () => {
    const res = negotiate('/docs/overview', MARKDOWN);
    expect(res.location).toBeNull();
    expect(res.status).toBe(200);
  });

  test.each([
    ['the docs index, which only redirects', '/docs'],
    ['the changelog, built from a different source adapter', '/docs/changelog'],
    ['a changelog release page', '/docs/changelog/v0.4.0'],
    ['a path outside the docs tree', '/continue'],
    ['a share page', '/d/abc123'],
  ])('%s is never negotiated', (_label, path) => {
    expect(negotiate(path, MARKDOWN).rewrittenTo).toBeNull();
  });

  test.each(['/docs/overview.md', '/docs/overview.html.md', '/docs/overview.mdx'])(
    '%s is left to the rewrite rules rather than negotiated again',
    (path) => {
      expect(negotiate(path, MARKDOWN).rewrittenTo).toBeNull();
    },
  );

  test('host canonicalization wins over negotiation', () => {
    const res = proxy(
      new NextRequest(`https://${WWW}/docs/overview`, { headers: { host: WWW, accept: MARKDOWN } }),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`https://${APEX}/docs/overview`);
  });

  test('the page a browser falls through to carries no Vary from the proxy', () => {
    const res = proxy(
      new NextRequest(`https://${APEX}/docs/overview`, {
        headers: { host: APEX, accept: BROWSER_ACCEPT },
      }),
    );
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
  });
});
