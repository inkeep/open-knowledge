export interface HeadingEntry {
  level: number;
  text: string;
  slug: string;
}

const COMBINING_MARK_RE = /\p{M}+/gu;
const NON_LETTER_OR_NUMBER_RE = /[^\p{L}\p{N}]+/gu;
const EDGE_HYPHENS_RE = /^-+|-+$/g;

export function toWikiLinkSlug(text: string): string {
  return text
    .trim()
    .normalize('NFKD')
    .replace(COMBINING_MARK_RE, '')
    .toLowerCase()
    .replace(NON_LETTER_OR_NUMBER_RE, '-')
    .replace(EDGE_HYPHENS_RE, '');
}

export function disambiguateSlug(baseSlug: string, slugCounts: Map<string, number>): string {
  const count = slugCounts.get(baseSlug) ?? 0;
  slugCounts.set(baseSlug, count + 1);
  return count === 0 ? baseSlug : `${baseSlug}-${count}`;
}

export function getHeadingSlug(text: string, slugCounts: Map<string, number>): string {
  const baseSlug = toWikiLinkSlug(text);
  return baseSlug ? disambiguateSlug(baseSlug, slugCounts) : '';
}

export function wikiLinkHref(target: string, anchor: string | null): string {
  const slug = toWikiLinkSlug(target);
  return anchor ? `#${slug}-${toWikiLinkSlug(anchor)}` : `#${slug}`;
}
