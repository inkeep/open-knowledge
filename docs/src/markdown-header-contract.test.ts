import { autoImplementMethods } from 'next/dist/server/route-modules/app-route/helpers/auto-implement-methods';
import type { AppRouteHandlers } from 'next/dist/server/route-modules/app-route/module';
import { describe, expect, test, vi } from 'vitest';
import nextConfig from '../next.config.ts';
import { filesNamed, ROUTE_FILES, readAppFile } from './app/app-files.test-helper.ts';

const CONTRACT = {
  'content-type': 'text/markdown; charset=utf-8',
  'cache-control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
  vary: 'Accept',
} as const;

const SHARED_HSTS = 'max-age=63072000; includeSubDomains; preload';

const MARKDOWN_SOURCE_MARKERS = ['markdownResponse', 'markdownRouteHandler', 'text/markdown'];

const markdownRouteFilesOnDisk = () =>
  filesNamed(ROUTE_FILES).filter((file) => {
    const source = readAppFile(file);
    return MARKDOWN_SOURCE_MARKERS.some((marker) => source.includes(marker));
  });

const OVERVIEW_URL = 'https://openknowledge.ai/docs/get-started/overview';

const overviewPage = {
  url: '/docs/get-started/overview',
  data: {
    title: 'Overview',
    description: 'What OpenKnowledge is.',
    getText: async () => 'Early days.\n',
  },
};

vi.doMock('@/lib/source', () => ({
  source: {
    getPage: (slug: string[]) =>
      slug.join('/') === 'get-started/overview' ? overviewPage : undefined,
    getPages: () => [overviewPage],
    generateParams: () => [{ slug: ['get-started', 'overview'] }],
  },
}));

vi.stubGlobal(
  'fetch',
  async () =>
    new Response(
      '<rss version="2.0"><channel><item><title>markdownlint</title>' +
        '<link>https://openknowledge.ai/blog/markdownlint-support</link></item></channel></rss>',
    ),
);

const perPageRoute = await import('@/app/llms.mdx/[...slug]/route.ts');
const llmsTxtRoute = await import('@/app/llms.txt/route.ts');
const llmsFullRoute = await import('@/app/llms-full.txt/route.ts');

type Handler = (...args: never[]) => Promise<Response> | Response;
type Method = 'GET' | 'HEAD';

interface MarkdownRoute {
  readonly name: string;
  readonly file: string;
  readonly canonicalUrl: string | null;
  readonly status: number;
  readonly module: { readonly GET: Handler };
  readonly call: (handler: Handler, method: Method) => Promise<Response> | Response;
}

const slugCall =
  (url: string, slug: string[]) =>
  (handler: Handler, method: Method): Promise<Response> =>
    (handler as typeof perPageRoute.GET)(new Request(url, { method }), {
      params: Promise.resolve({ slug }),
    });
const bareCall = (handler: Handler) => (handler as () => Promise<Response>)();

const ROUTES: MarkdownRoute[] = [
  {
    name: 'a docs page',
    file: 'llms.mdx/[...slug]/route.ts',
    canonicalUrl: OVERVIEW_URL,
    status: 200,
    module: perPageRoute,
    call: slugCall(`${OVERVIEW_URL}.md`, ['get-started', 'overview']),
  },
  {
    name: 'a docs page nobody holds',
    file: 'llms.mdx/[...slug]/route.ts',
    canonicalUrl: null,
    status: 404,
    module: perPageRoute,
    call: slugCall('https://openknowledge.ai/docs/nope.md', ['nope']),
  },
  {
    name: 'llms.txt',
    file: 'llms.txt/route.ts',
    canonicalUrl: null,
    status: 200,
    module: llmsTxtRoute,
    call: bareCall,
  },
  {
    name: 'llms-full.txt',
    file: 'llms-full.txt/route.ts',
    canonicalUrl: null,
    status: 200,
    module: llmsFullRoute,
    call: bareCall,
  },
];

const serve = (route: MarkdownRoute) => route.call(route.module.GET, 'GET');

const served = new Map(
  await Promise.all(ROUTES.map(async (route) => [route, await serve(route)] as const)),
);

describe('every Markdown response the docs app serves', () => {
  test.each(ROUTES)('$name carries the shared header contract', (route) => {
    const headers = served.get(route)?.headers;
    for (const [header, value] of Object.entries(CONTRACT)) {
      expect(headers?.get(header), `${header} on ${route.name}`).toBe(value);
    }
  });

  test.each(ROUTES)('$name points agents at the page they should cite', (route) => {
    const expected = route.canonicalUrl ? `<${route.canonicalUrl}>; rel="canonical"` : null;
    expect(served.get(route)?.headers.get('link'), `Link on ${route.name}`).toBe(expected);
  });

  test.each(ROUTES)('$name answers with the status it promises', (route) => {
    expect(served.get(route)?.status, route.name).toBe(route.status);
  });

  test('is a census: no route file serves Markdown without being pinned here', () => {
    const unpinned = markdownRouteFilesOnDisk().filter(
      (file) => !ROUTES.some((route) => route.file === file),
    );

    expect(
      unpinned,
      'route files serving Markdown that this contract never checks; add each to ROUTES',
    ).toEqual([]);
  });

  test('the census sees a handler authored as .tsx', () => {
    expect(filesNamed(ROUTE_FILES).filter((file) => file.endsWith('.tsx')).length).toBeGreaterThan(
      0,
    );
  });

  test('the census reaches the routes it names', () => {
    const onDisk = new Set(filesNamed(ROUTE_FILES));
    expect(ROUTES.filter((route) => !onDisk.has(route.file)).map((route) => route.file)).toEqual(
      [],
    );
    expect(ROUTES.length).toBeGreaterThan(1);
  });
});

describe('a HEAD request to every Markdown route', () => {
  const HEAD_ROUTES = ROUTES.filter(
    (route, index) => ROUTES.findIndex((other) => other.file === route.file) === index,
  );

  test('covers every Markdown route file on disk, once', () => {
    const files = HEAD_ROUTES.map((route) => route.file);
    expect(new Set(files)).toEqual(new Set(markdownRouteFilesOnDisk()));
    expect(files.length).toBe(new Set(files).size);
  });

  test.each(HEAD_ROUTES)('$name is answered by its GET handler, which reads no method', async ({
    module,
    call,
  }) => {
    expect(module).not.toHaveProperty('HEAD');
    const methods = autoImplementMethods(module as unknown as AppRouteHandlers);
    expect(methods.HEAD).toBe(module.GET);

    const headers = (await call(methods.HEAD as never, 'HEAD')).headers;
    for (const [header, value] of Object.entries(CONTRACT)) {
      expect(headers.get(header), `${header} on HEAD`).toBe(value);
    }
  });
});

describe('the header layer next.config.ts adds on top', () => {
  async function configRules() {
    return (await nextConfig.headers?.()) ?? [];
  }

  test('sets no header the Markdown contract also sets', async () => {
    const collisions = (await configRules()).flatMap((rule) =>
      rule.headers
        .filter((header) => {
          const key = header.key.toLowerCase();
          return key in CONTRACT || key === 'link';
        })
        .map((header) => `${rule.source} sets ${header.key}`),
    );

    expect(collisions, 'config headers colliding with the Markdown contract').toEqual([]);
  });

  test('sends the same Strict-Transport-Security value as the marketing app', async () => {
    const values = (await configRules()).flatMap((rule) =>
      rule.headers
        .filter((header) => header.key.toLowerCase() === 'strict-transport-security')
        .map((header) => header.value),
    );

    expect(values).toEqual([SHARED_HSTS]);
  });
});
