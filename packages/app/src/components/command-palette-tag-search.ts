
import {
  fetchTags,
  rankTagsByQuery,
  type TagSummaryEntry,
} from '../editor/extensions/tag-suggestion.ts';

export const TAG_QUERY_PREFIX = 'tag:';

type TagPaletteMode =
  | { kind: 'normal'; query: string }
  | { kind: 'tag-list'; query: string }
  | { kind: 'tag-docs'; tagName: string };

export function parseTagPaletteQuery(
  query: string,
  knownTagNames: ReadonlySet<string>,
): TagPaletteMode {
  if (!query.toLowerCase().startsWith(TAG_QUERY_PREFIX)) {
    return { kind: 'normal', query };
  }
  const suffix = query.slice(TAG_QUERY_PREFIX.length).replace(/^\s+/, '').trim();
  if (suffix && knownTagNames.has(suffix)) {
    return { kind: 'tag-docs', tagName: suffix };
  }
  return { kind: 'tag-list', query: suffix };
}

export function filterTagList(tags: readonly TagSummaryEntry[], query: string): TagSummaryEntry[] {
  return rankTagsByQuery(tags, query);
}

export interface TagDocEntry {
  docName: string;
  title: string;
  matchingTags: string[];
  snippet: string | null;
}

export const fetchTagsList = fetchTags;

export async function fetchDocsForTag(name: string): Promise<TagDocEntry[]> {
  const r = await fetch(`/api/tags/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`/api/tags/${name} responded with ${r.status}`);
  const data: { docs?: TagDocEntry[] } = await r.json();
  return Array.isArray(data.docs) ? data.docs : [];
}
