const TAG_HIERARCHY_SEPARATOR = '/';

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
