/**
 * command-palette-tag-search — `tag:` query-prefix support for the
 * Cmd+K omnibar.
 *
 * Authoring shape:
 *
 *   `tag:` (just the prefix)        → list all known tags as picker
 *   `tag:fr`                        → tags whose name contains `fr`
 *   `tag:frontend`                  → docs registered under `#frontend`
 *                                     (or any of its hierarchy children
 *                                     via the server's rollup)
 *
 * The recogniser is loose on whitespace (`tag: foo` works the same as
 * `tag:foo`) but case-sensitive on the tag name, matching the
 * server-side `TagIndex` semantics. Hierarchical tags (`proj/team`)
 * pass through verbatim — slashes are valid in tag names per the
 * inline `#proj/team` syntax.
 *
 * The tag-list / tag-rank logic lives in `tag-suggestion.ts` and is
 * imported here — single source of truth for `/api/tags` consumption
 * and ranking, shared with the editor's `#` typeahead.
 */

import {
  fetchTags,
  rankTagsByQuery,
  type TagSummaryEntry,
} from '../editor/extensions/tag-suggestion.ts';

export const TAG_QUERY_PREFIX = 'tag:';

/**
 * Result of parsing a Cmd+K input. The `mode` field discriminates the
 * three states the tag-search dropdown can be in.
 */
type TagPaletteMode =
  | { kind: 'normal'; query: string }
  | { kind: 'tag-list'; query: string }
  | { kind: 'tag-docs'; tagName: string };

/**
 * Discriminate the input shape. Pure function — no I/O.
 *
 *   - Doesn't start with `tag:` → `normal` (host falls through to
 *     workspace search).
 *   - Starts with `tag:` and the suffix is empty / partial / no exact
 *     match → `tag-list` (show tag picker).
 *   - Starts with `tag:` and the suffix matches a known tag exactly
 *     → `tag-docs` (show docs registered under that tag).
 *
 * Exact match-or-not depends on the runtime tag set, so the caller
 * passes `knownTagNames`. Empty set means we're still loading — we
 * stay in `tag-list` so the picker can render an "fetching tags"
 * placeholder.
 */
export function parseTagPaletteQuery(
  query: string,
  knownTagNames: ReadonlySet<string>,
): TagPaletteMode {
  if (!query.toLowerCase().startsWith(TAG_QUERY_PREFIX)) {
    return { kind: 'normal', query };
  }
  // Strip the prefix + any whitespace immediately after the colon so
  // `tag: frontend` and `tag:frontend` parse the same. Trim the
  // trailing whitespace too — leading/trailing whitespace in a tag
  // name isn't representable in source markdown anyway.
  const suffix = query.slice(TAG_QUERY_PREFIX.length).replace(/^\s+/, '').trim();
  if (suffix && knownTagNames.has(suffix)) {
    return { kind: 'tag-docs', tagName: suffix };
  }
  return { kind: 'tag-list', query: suffix };
}

/**
 * Filter + rank the tag list for the `tag-list` mode. Thin wrapper
 * around the shared `rankTagsByQuery` so the palette and editor
 * surfaces share one definition of "best match" — the editor's
 * `buildTagSuggestionItems` calls the same ranker, then caps and
 * decorates with a "create" affordance. The palette doesn't cap (its
 * CommandList scrolls) and doesn't offer creation (the omnibar is a
 * navigator, not an authoring surface).
 */
export function filterTagList(tags: readonly TagSummaryEntry[], query: string): TagSummaryEntry[] {
  return rankTagsByQuery(tags, query);
}

/**
 * Doc registered under a tag, as returned by `/api/tags/:name`. Each
 * doc carries the literal authored tags that fell under the queried
 * prefix — `matchingTags` is non-empty and captures the rollup hit
 * that brought this doc into the result list (e.g. querying `#proj`
 * surfaces a doc tagged `#proj/team/2026` with `matchingTags:
 * ['proj/team/2026']`).
 */
export interface TagDocEntry {
  docName: string;
  title: string;
  matchingTags: string[];
  snippet: string | null;
}

/**
 * Fetch the workspace tag list. Re-exported from `tag-suggestion.ts`
 * (single source of truth) under the palette-side name so callers in
 * this directory don't need a cross-directory import for what reads
 * as a palette concern.
 */
export const fetchTagsList = fetchTags;

export async function fetchDocsForTag(name: string): Promise<TagDocEntry[]> {
  const r = await fetch(`/api/tags/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`/api/tags/${name} responded with ${r.status}`);
  const data: { docs?: TagDocEntry[] } = await r.json();
  return Array.isArray(data.docs) ? data.docs : [];
}
