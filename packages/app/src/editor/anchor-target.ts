import { toWikiLinkSlug } from '@inkeep/open-knowledge-core/utils/slug';

function findById(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
}

export function findAnchorTarget(root: ParentNode, anchor: string): HTMLElement | null {
  const exact =
    findById(root, anchor) ??
    root.querySelector<HTMLElement>(`[data-mirror-source-id="${CSS.escape(anchor)}"]`);
  if (exact) return exact;
  const slug = toWikiLinkSlug(anchor);
  return slug && slug !== anchor ? findById(root, slug) : null;
}
