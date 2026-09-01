import type { Node as PmNode } from '@tiptap/pm/model';
import { getSharedMarkdownManager } from './md-singleton.ts';

export function reconstructSource(node: PmNode): string {
  if (!node.attrs.sourceDirty && node.attrs.sourceRaw) {
    return node.attrs.sourceRaw as string;
  }

  const mdManager = getSharedMarkdownManager();
  const doc = node.type.schema.node('doc', null, [node]);
  return mdManager.serialize(doc.toJSON()).trim();
}
