/**
 * Tag rollup helpers — pure functions for hierarchical tag expansion + prefix
 * lookup. Used by the server-side `TagIndex` to fan out a single authored tag
 * (`'proj/team/2026'`) across all of its hierarchical prefixes so a query for
 * `'proj'` returns every doc under that branch in O(1).
 *
 * Hierarchy semantics mirror Obsidian's `parent/child` slash convention. The
 * separator is `/` only — neither `-` nor `_` introduce hierarchy. Tags are
 * case-sensitive (`Project` and `project` are distinct).
 *
 * No state, no side effects. Co-located with the slug/path utilities in
 * `core/utils/` rather than the markdown pipeline because the rollup logic
 * belongs to the index layer, not the parse layer.
 */

const TAG_HIERARCHY_SEPARATOR = '/';

/**
 * Expand a single tag value into the ordered list of hierarchical prefixes it
 * implies. `'proj/team/2026'` → `['proj', 'proj/team', 'proj/team/2026']`.
 *
 * Empty input yields an empty array. Single-segment tags yield a one-element
 * array. The original tag is always the last element when the input is
 * non-empty — callers can dedupe across docs by treating the array as a set.
 *
 * Whitespace inside segments is preserved verbatim. The promoter regex
 * (`tag-promotion.ts`) already constrains segment characters to
 * `[a-zA-Z][\w/-]*` at parse time, so callers feeding values from frontmatter
 * are responsible for their own validation — this function does not assert.
 */
export function expandTagToHierarchy(tag: string): string[] {
  if (!tag) return [];
  const segments = tag.split(TAG_HIERARCHY_SEPARATOR);
  const out: string[] = [];
  let acc = '';
  for (const seg of segments) {
    acc = acc ? `${acc}${TAG_HIERARCHY_SEPARATOR}${seg}` : seg;
    out.push(acc);
  }
  return out;
}

/**
 * Filter a set of expanded tags down to those equal to `prefix` or starting
 * with `prefix + '/'`. Used by rollup-mode queries that ask "which authored
 * tags fall under this branch" — distinct from the indexed-by-prefix lookup
 * the index does internally.
 *
 * Tag equality is exact-match. `'proj-x'` does NOT match prefix `'proj'`
 * because the separator check requires a literal slash; `-` is part of a
 * single segment.
 *
 * Empty inputs return an empty set. Empty prefix returns the input unchanged
 * (every tag matches the root).
 */
export function tagsMatchingPrefix(allTags: Set<string>, prefix: string): Set<string> {
  if (allTags.size === 0) return new Set();
  if (prefix === '') return new Set(allTags);
  const out = new Set<string>();
  const childPrefix = `${prefix}${TAG_HIERARCHY_SEPARATOR}`;
  for (const tag of allTags) {
    if (tag === prefix || tag.startsWith(childPrefix)) {
      out.add(tag);
    }
  }
  return out;
}
