const DOCS_ROUTE = '/docs';

export const PAGE_MARKDOWN_ROUTE = '/llms.mdx';

const MARKDOWN_TWIN_SUFFIXES = ['.html.md', '.md', '.mdx'];

export const NO_MARKDOWN_PREFIXES = [`${DOCS_ROUTE}/changelog`] as const;

function noMarkdownPrefixFor(docsPath: string): string | null {
  return (
    NO_MARKDOWN_PREFIXES.find(
      (prefix) => docsPath === prefix || docsPath.startsWith(`${prefix}/`),
    ) ?? null
  );
}

export function unrenditionedSubtree(slug: readonly string[]): string | null {
  return noMarkdownPrefixFor(`${DOCS_ROUTE}/${slug.join('/')}`);
}

interface RewriteRule {
  source: string;
  destination: string;
}

export function markdownRewrites(): RewriteRule[] {
  return MARKDOWN_TWIN_SUFFIXES.map((suffix) => ({
    source: `${DOCS_ROUTE}/:path*${suffix}`,
    destination: `${PAGE_MARKDOWN_ROUTE}/:path*`,
  }));
}

function trimTrailingSlashes(pathname: string): string {
  let end = pathname.length;
  while (end > 1 && pathname.charCodeAt(end - 1) === 47) end -= 1;
  return pathname.slice(0, end);
}

export function markdownHandlerForPage(pathname: string): string | null {
  const path = trimTrailingSlashes(pathname);

  if (MARKDOWN_TWIN_SUFFIXES.some((suffix) => path.endsWith(suffix))) return null;
  if (noMarkdownPrefixFor(path)) return null;
  if (!path.startsWith(`${DOCS_ROUTE}/`)) return null;

  return `${PAGE_MARKDOWN_ROUTE}${path.slice(DOCS_ROUTE.length)}`;
}
