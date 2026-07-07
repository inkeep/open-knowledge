/** Shared heading/anchor slug interface — used by API responses and client-side consumers. */
export interface HeadingEntry {
  level: number;
  text: string;
  /** URL-safe slug derived from the heading text — matches wiki link anchor syntax. */
  slug: string;
}

const COMBINING_MARK_RE = /\p{M}+/gu;
const NON_LETTER_OR_NUMBER_RE = /[^\p{L}\p{N}]+/gu;
const EDGE_HYPHENS_RE = /^-+|-+$/g;

/**
 * Convert arbitrary heading text to a URL-safe slug suitable for wiki link anchors.
 * Any run of non-alphanumeric characters becomes a single hyphen; leading/trailing
 * hyphens are stripped.
 *
 * This is the canonical implementation shared between:
 *   - server  (api-extension.ts — generates slugs for /api/page-headings)
 *   - app     (wiki-link-helpers.ts, heading-anchors.ts — renders heading IDs + resolves links)
 */
export function toWikiLinkSlug(text: string): string {
  return text
    .trim()
    .normalize('NFKD')
    .replace(COMBINING_MARK_RE, '')
    .toLowerCase()
    .replace(NON_LETTER_OR_NUMBER_RE, '-')
    .replace(EDGE_HYPHENS_RE, '');
}

/** Reuse the same duplicate-slug suffixing across server and client heading IDs. */
export function disambiguateSlug(baseSlug: string, slugCounts: Map<string, number>): string {
  const count = slugCounts.get(baseSlug) ?? 0;
  slugCounts.set(baseSlug, count + 1);
  return count === 0 ? baseSlug : `${baseSlug}-${count}`;
}

export function getHeadingSlug(text: string, slugCounts: Map<string, number>): string {
  const baseSlug = toWikiLinkSlug(text);
  return baseSlug ? disambiguateSlug(baseSlug, slugCounts) : '';
}

/**
 * Build the href for a wikiLink. Target slug + optional anchor fragment.
 * Stable across destinations: the href is a fragment identifier that
 * external destinations treat as an in-document anchor; OK-internal paste
 * back recovers structure from `data-target/anchor/alias`.
 *
 * Shared by:
 *   - mdast→hast wikiLink/wikiLinkEmbed handlers (markdown→HTML pipeline)
 *   - clipboard walker wiki-link transform (live-DOM `<span data-wiki-link>`
 *     → `<a href="#${slug}">` rewrite)
 *
 * Both paths must produce byte-identical hrefs so cross-pipeline emissions
 * collapse to the same destination anchor.
 */
export function wikiLinkHref(target: string, anchor: string | null): string {
  const slug = toWikiLinkSlug(target);
  return anchor ? `#${slug}-${toWikiLinkSlug(anchor)}` : `#${slug}`;
}
