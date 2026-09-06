import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match.js';
import { prepareDestination } from 'next/dist/shared/lib/router/utils/prepare-destination.js';
import { describe, expect, test } from 'vitest';
import nextConfig from '../next.config.ts';

async function rewritePhases() {
  const rewrites = await nextConfig.rewrites?.();
  if (!rewrites || Array.isArray(rewrites)) {
    throw new Error('rewrites() must return { beforeFiles, afterFiles }');
  }
  return { beforeFiles: rewrites.beforeFiles ?? [], afterFiles: rewrites.afterFiles ?? [] };
}

async function rewriteOf(pathname: string): Promise<string | null> {
  const rules = (await rewritePhases()).beforeFiles;

  for (const rule of rules) {
    const params = getPathMatch(rule.source, { removeUnnamedParams: true, strict: true })(pathname);
    if (!params) continue;
    return prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params,
      query: {},
    }).newUrl;
  }
  return null;
}

describe('docs Markdown rewrites', () => {
  test.each([
    ['/docs/get-started/quickstart.md'],
    ['/docs/get-started/quickstart.html.md'],
    ['/docs/get-started/quickstart.mdx'],
  ])('%s serves the markdown rendition of the same page', async (url) => {
    expect(await rewriteOf(url)).toBe('/llms.mdx/get-started/quickstart');
  });

  test('a single-segment slug resolves too', async () => {
    expect(await rewriteOf('/docs/overview.html.md')).toBe('/llms.mdx/overview');
  });

  test('a page whose own name ends in .html keeps its slug', async () => {
    expect(await rewriteOf('/docs/guides/index.html.md')).toBe('/llms.mdx/guides/index');
  });

  test('the human page is left alone', async () => {
    expect(await rewriteOf('/docs/get-started/quickstart')).toBeNull();
  });

  test('every markdown rule sits in beforeFiles, and none in afterFiles', async () => {
    const { beforeFiles, afterFiles } = await rewritePhases();
    expect(beforeFiles.map((rule) => rule.destination)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\/llms\.mdx\//)]),
    );
    expect(afterFiles.filter((rule) => rule.destination.startsWith('/llms.mdx'))).toEqual([]);
  });

  test('keeps the PostHog proxy rules in afterFiles, in their existing order', async () => {
    const { afterFiles } = await rewritePhases();
    const sources = afterFiles.map((rule) => rule.source);
    expect(sources).toEqual(['/ingest/static/:path*', '/ingest/array/:path*', '/ingest/:path*']);
  });
});
