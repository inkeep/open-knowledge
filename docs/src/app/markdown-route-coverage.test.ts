import { describe, expect, test } from 'vitest';
import { markdownHandlerForPage, PAGE_MARKDOWN_ROUTE } from '@/lib/markdown-routes';
import {
  filesNamed,
  METADATA_ROUTE_FILES,
  metadataRouteName,
  PAGE_FILES,
  ROUTE_FILES,
} from './app-files.test-helper.ts';

const NO_MARKDOWN: Record<string, string> = {
  '/continue': 'hand-off screen for the desktop app; carries no durable content',
  '/d/[encoded]': 'renders a share payload carried in the URL, unlisted and ephemeral by design',
  '/docs': 'redirects to the overview page rather than rendering content of its own',
  '/docs/changelog':
    "built from the CLI's own CHANGELOG.md through a source adapter the Markdown handler cannot read",
  '/docs/changelog/[tag]':
    "built from the CLI's own CHANGELOG.md through a source adapter the Markdown handler cannot read",
};

const ROUTE_GROUP = /^\(.+\)$/;
const DYNAMIC_SEGMENT = /^\[(\.\.\.)?[^[\]./]+\]$/;
const LITERAL_SEGMENT = /^[\w.-]+$/;

function routePathOf(file: string): string {
  const segments = file.split('/').slice(0, -1);
  const parts = segments.filter((segment) => {
    if (ROUTE_GROUP.test(segment)) return false;
    if (DYNAMIC_SEGMENT.test(segment) || LITERAL_SEGMENT.test(segment)) return true;
    throw new Error(`unrecognised app-router segment "${segment}" in ${file}`);
  });
  return `/${parts.join('/')}`;
}

function metadataRoutePathOf(file: string): string {
  const fileName = file.slice(file.lastIndexOf('/') + 1);
  const dir = routePathOf(file);
  const served = metadataRouteName(fileName, file);
  if (!served) throw new Error(`unmapped metadata-route convention "${fileName}" in ${file}`);
  return `${dir === '/' ? '' : dir}/${served}`;
}

function sampleUrlOf(routePath: string): string {
  return routePath.replace(/\[(?:\.\.\.)?([^[\]]+)\]/g, 'sample-$1');
}

function routeMatcher(routePath: string): RegExp {
  const body = routePath
    .split('/')
    .map((segment) => {
      if (/^\[\.\.\..+\]$/.test(segment)) return '.+';
      if (/^\[.+\]$/.test(segment)) return '[^/]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${body}$`);
}

const pageRoutes = filesNamed(PAGE_FILES).map((file) => ({ file, route: routePathOf(file) }));
const handlerRoutes = filesNamed(ROUTE_FILES).map(routePathOf);

const nonPageRoutes = [
  ...filesNamed(ROUTE_FILES).map(routePathOf),
  ...filesNamed(METADATA_ROUTE_FILES).map(metadataRoutePathOf),
].filter((route) => !route.startsWith(`${PAGE_MARKDOWN_ROUTE}/`));

describe('markdown route coverage', () => {
  test('every page route has a markdown producer or a stated exemption', () => {
    const uncovered = pageRoutes
      .filter(({ route }) => !markdownHandlerForPage(sampleUrlOf(route)) && !NO_MARKDOWN[route])
      .map(
        ({ file, route }) =>
          `${route} (src/app/${file}): serve it from src/lib/markdown-routes.ts, or add "${route}" to NO_MARKDOWN in this file with the reason it has none`,
      );

    expect(uncovered, 'page routes with neither a markdown rendition nor an exemption').toEqual([]);
  });

  test('the census reaches the pages it is meant to police', () => {
    expect(pageRoutes.map(({ route }) => route)).toContain('/docs/[...slug]');
  });

  test.each(Object.entries(NO_MARKDOWN))('%s is exempt from markdown: %s', (route, reason) => {
    expect(reason.trim(), `${route} is exempted without saying why`).not.toBe('');
    expect(
      pageRoutes.map((page) => page.route),
      `${route} is exempted but no page renders it; drop the NO_MARKDOWN entry`,
    ).toContain(route);
    expect(
      markdownHandlerForPage(sampleUrlOf(route)),
      `${route} is exempted but does have a markdown rendition; drop the NO_MARKDOWN entry`,
    ).toBeNull();
  });

  test('never negotiates a non-page route into a markdown handler', () => {
    const negotiating = nonPageRoutes
      .filter((route) => markdownHandlerForPage(sampleUrlOf(route)) !== null)
      .map(
        (route) =>
          `${route}: a Markdown-preferring agent gets a 404 instead of this route's own body; add its prefix to NO_MARKDOWN_PREFIXES in src/lib/markdown-routes.ts`,
      );

    expect(negotiating, 'non-page routes that shape alone maps to a slug handler').toEqual([]);
  });

  test('reaches the non-page routes it is meant to police', () => {
    expect(nonPageRoutes).toContain('/docs/changelog/rss.xml');
  });

  test('every markdown producer names a handler this app implements', () => {
    const missing = pageRoutes
      .map(({ route }) => ({ route, handler: markdownHandlerForPage(sampleUrlOf(route)) }))
      .filter(
        ({ handler }) =>
          handler !== null && !handlerRoutes.some((r) => routeMatcher(r).test(handler)),
      )
      .map(({ route, handler }) => `${route} -> ${handler} (no route.ts serves it)`);

    expect(missing, 'markdown producers with no handler').toEqual([]);
  });

  test('enumerates every spelling the router accepts for each convention', () => {
    for (const list of [PAGE_FILES, ROUTE_FILES]) {
      expect(list.map((name) => name.split('.').pop())?.sort()).toEqual(['js', 'jsx', 'ts', 'tsx']);
    }
    expect([...new Set(METADATA_ROUTE_FILES.map((name) => name.split('.')[0]))].sort()).toEqual([
      'apple-icon',
      'icon',
      'manifest',
      'opengraph-image',
      'robots',
      'sitemap',
      'twitter-image',
    ]);
    expect(METADATA_ROUTE_FILES).toHaveLength(28);
  });

  test.each([
    ['sitemap.ts', 'blog/sitemap.ts', 'sitemap.xml'],
    ['sitemap.ts', '(home)/blog/sitemap.ts', 'sitemap.xml'],
    ['opengraph-image.tsx', 'blog/opengraph-image.tsx', 'opengraph-image'],
    ['opengraph-image.tsx', '(home)/blog/opengraph-image.tsx', 'opengraph-image-a1b2c3'],
    ['opengraph-image.png', 'blog/opengraph-image.png', null],
    ['route.ts', 'blog/route.ts', null],
  ])('serves %s (source %s) at %s', (fileName, sourcePath, expected) => {
    expect(metadataRouteName(fileName, sourcePath)).toBe(expected);
  });
});
