/**
 * Frontmatter `tags:` extractor + per-entry validator.
 *
 * The per-doc YAML region admits a flat array of textually-representable
 * scalars under the conventional `tags` key (`tags: [a, b/c]`); non-string
 * scalars are coerced to string at the schema layer (see
 * `frontmatter/schema.ts`). Inline `#tag` and frontmatter `tags:` feed the
 * same server-side `TagIndex` — this helper is the single source of truth
 * for what the indexer accepts out of the YAML half.
 *
 * Validation regex is deliberately MORE permissive than the inline tag
 * promoter's pattern (`tag-promotion.ts`'s `INLINE_TAG_VALUE_RE`): the
 * frontmatter `tags:` list is an explicit, unambiguous surface, so a leading
 * digit is fine (`2026`, a year, is a legitimate tag). The inline `#tag`
 * surface keeps the leading-letter rule because `#123` in prose collides
 * with issue-reference conventions and a numeric-only inline tag would not
 * round-trip (a serialized `#123` re-parses as plain text). Only the trailing
 * character class is shared. Frontmatter tags that fail the regex are dropped
 * with a `console.warn`; we don't fail the whole frontmatter parse — authors
 * should not lose valid tags because one entry has a stray space or `#` prefix.
 *
 * Single-tag scalar (`tags: showcase`) is accepted as a one-element list
 * because the property panel's list widget round-trips a single entry as a
 * scalar in some YAML emitters; the indexer should not care which shape it
 * sees on disk.
 */

import { parseFrontmatterYaml } from './yaml-codec.ts';

/**
 * Regex that matches a valid bare tag value (no `#` prefix) in a frontmatter
 * `tags:` list. Leading char may be a letter OR digit — unlike the inline
 * `#tag` grammar (`tag-promotion.ts`'s `INLINE_TAG_VALUE_RE`), which requires
 * a leading letter. The frontmatter list is explicit and never round-trips
 * through prose, so `2026` (a year) is a valid tag here even though `#2026`
 * in body text is intentionally left as plain text. The leading class mirrors
 * the inline regex's `[a-zA-Z]` ordering with `0-9` appended, so the only
 * intentional difference reads at a glance on a diff.
 */
export const FRONTMATTER_TAG_VALUE_RE = /^[a-zA-Z0-9][\w/-]*$/;

/**
 * Pure predicate over a candidate tag value. Centralizes the per-character
 * regex check the renderer surfaces (`PropertyWidgets` chip, `TagPillInput`
 * pill) call to flag invalid tags with red + tooltip — keeps the two
 * surfaces convergent on the same shape `extractFrontmatterTags` enforces
 * at parse time.
 *
 * The `#`-stripped value is what flows on disk and into the indexer, so
 * this predicate also accepts a leading `#` for convenience: callers that
 * receive a raw author-typed string can pass it through without first
 * stripping. The strip is identical to `stripLeadingHash` (private).
 */
export function isValidFrontmatterTagValue(value: string): boolean {
  if (typeof value !== 'string') return false;
  const stripped = value.startsWith('#') ? value.slice(1) : value;
  return FRONTMATTER_TAG_VALUE_RE.test(stripped);
}

/**
 * Single canonical user-facing description of the tag-value grammar. Used
 * verbatim as a tooltip / helper-text string on the WYSIWYG surfaces that
 * surface validation failures.
 */
export const FRONTMATTER_TAG_GRAMMAR_HINT =
  'Tags must start with a letter or digit and contain only letters, digits, underscores, dashes, and slashes.';

/**
 * Strip a single leading `#` if the author wrote it; the indexer keys on
 * bare values. Tolerated because some Obsidian plugins emit `tags: ['#x']`
 * even though the canonical Obsidian shape is bare.
 */
function stripLeadingHash(value: string): string {
  return value.startsWith('#') ? value.slice(1) : value;
}

/**
 * Coerce the YAML value at `tags` into a list of candidate strings. Accepts:
 *   - `[a, b]` (the canonical shape)
 *   - `a` (a scalar — treated as a one-element list)
 *   - missing / null / non-string / non-array → empty list
 *
 * Schema-level coercion (`FrontmatterValueSchema` in `schema.ts`) already
 * normalizes array elements to strings; the typeof filter is a defensive
 * guard for the `unknown`-typed parameter — it would only fire if a caller
 * passed an unparsed JS value that bypassed the schema.
 */
function coerceCandidates(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Extract validated tag values from a frontmatter YAML body (no fences).
 * Empty input or missing `tags` key returns an empty array. Invalid entries
 * are silently dropped; the return value contains only entries matching
 * `FRONTMATTER_TAG_VALUE_RE`.
 *
 * Caller passes the YAML body, NOT a fenced frontmatter block — this matches
 * the contract of `parseFrontmatterYaml` (which also expects unfenced YAML).
 * Use `unwrapFrontmatterFences` from `extensions/frontmatter.ts` first if
 * starting from a `---\n…\n---` block.
 */
export function extractFrontmatterTags(yaml: string): string[] {
  if (!yaml || yaml.trim() === '') return [];
  const { map } = parseFrontmatterYaml(yaml);
  if (!map) return [];
  const candidates = coerceCandidates(map.tags);
  const out: string[] = [];
  for (const candidate of candidates) {
    const stripped = stripLeadingHash(candidate);
    // Silently drop entries that don't match the tag grammar. Comma-joined or
    // spaced values (e.g. Obsidian's `tags: "a, b"`) are common real-world
    // content, not an error — and this runs once per doc during the startup
    // tag/backlinks reconcile, so a per-entry warn floods stdout. A
    // constructive surface for dropped tags belongs in a one-shot lint, not
    // this hot path.
    if (FRONTMATTER_TAG_VALUE_RE.test(stripped)) {
      out.push(stripped);
    }
  }
  return out;
}
