import { toWikiLinkSlug } from '@inkeep/open-knowledge-core/utils/slug';
import { mirrorSourceNameFromAnchor } from '@/lib/doc-hash';

function findById(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
}

function findMirrorSource(root: ParentNode, name: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-mirror-source-name="${CSS.escape(name)}"]`);
}

export function findAnchorTarget(root: ParentNode, anchor: string): HTMLElement | null {
  const sourceName = mirrorSourceNameFromAnchor(anchor);
  const linkedSource = sourceName === null ? null : findMirrorSource(root, sourceName);
  if (linkedSource) return linkedSource;
  const exact = findById(root, anchor) ?? findMirrorSource(root, anchor);
  if (exact) return exact;
  const slug = toWikiLinkSlug(anchor);
  return slug && slug !== anchor ? findById(root, slug) : null;
}
