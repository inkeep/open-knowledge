export interface HeadingEntry {
  level: number;
  text: string;
  slug: string;
}

const MARK_RUN_RE = /(^|\P{M})(\p{M}+)/gu;
const MARK_KEEPING_BASE_RE =
  /^(?![\p{Script_Extensions=Latin}\p{Script_Extensions=Greek}\p{Script_Extensions=Cyrillic}\p{Script_Extensions=Arabic}\p{Script_Extensions=Hebrew}])\p{L}$/u;
const DEFAULT_IGNORABLE_RE = /\p{DI}/gu;
const NON_SLUG_CHARACTER_RE = /[^\p{L}\p{M}\p{N}]+/gu;
const EDGE_HYPHENS_RE = /^-+|-+$/g;

function foldMarkRun(_run: string, base: string, marks: string): string {
  return MARK_KEEPING_BASE_RE.test(base) ? base + marks.replace(DEFAULT_IGNORABLE_RE, '') : base;
}

export function toWikiLinkSlug(text: string): string {
  return text
    .trim()
    .normalize('NFKD')
    .replace(MARK_RUN_RE, foldMarkRun)
    .normalize('NFC')
    .toLowerCase()
    .replace(NON_SLUG_CHARACTER_RE, '-')
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
