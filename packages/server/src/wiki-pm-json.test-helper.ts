export type PmJson = {
  type?: string;
  attrs?: Record<string, unknown>;
  marks?: PmJson[];
  text?: string;
  content?: PmJson[];
};

export function findWikiLinkAttrs(node: PmJson): Record<string, unknown> | null {
  if (node.type === 'wikiLink') return node.attrs ?? null;
  for (const child of node.content ?? []) {
    const found = findWikiLinkAttrs(child);
    if (found) return found;
  }
  return null;
}

export function findWikiEmbedMarkAttrs(node: PmJson): Record<string, unknown> | null {
  for (const mark of node.marks ?? []) {
    if (mark.type === 'link' && mark.attrs?.sourceForm === 'wikiembed') {
      return mark.attrs as Record<string, unknown>;
    }
  }
  for (const child of node.content ?? []) {
    const found = findWikiEmbedMarkAttrs(child);
    if (found) return found;
  }
  return null;
}
