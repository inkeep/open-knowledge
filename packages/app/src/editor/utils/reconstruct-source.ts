/**
 * Reconstruct the raw MDX source text for a jsxComponent PM node.
 *
 * Used when converting a jsxComponent to rawMdxFallback for source editing
 * (render failures, wildcard/unregistered components).
 *
 * - Pristine (sourceDirty=false): returns sourceRaw verbatim (byte-identical)
 * - Dirty (sourceDirty=true): reconstructs via MarkdownManager serialize (γ path)
 */
import type { Node as PmNode } from '@tiptap/pm/model';
import { getSharedMarkdownManager } from './md-singleton.ts';

export function reconstructSource(node: PmNode): string {
  // Pristine — use sourceRaw for byte-identical source
  if (!node.attrs.sourceDirty && node.attrs.sourceRaw) {
    return node.attrs.sourceRaw as string;
  }

  // Dirty or no sourceRaw — reconstruct via the γ serialize path
  const mdManager = getSharedMarkdownManager();
  const doc = node.type.schema.node('doc', null, [node]);
  return mdManager.serialize(doc.toJSON()).trim();
}
