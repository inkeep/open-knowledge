import type { Link, LinkReference, Nodes, Parent, Root, Text } from 'mdast';
import type { VFile } from 'vfile';
import { isNonRenderingRange, maskNonRenderingContexts } from './non-rendering-contexts.ts';

function isLinkShaped(node: Nodes): node is Link | LinkReference {
  return node.type === 'link' || node.type === 'linkReference';
}

function demoteInPlace(
  parent: Parent,
  index: number,
  node: Link | LinkReference,
  source: string,
): void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return;
  const raw = source.slice(start, end);
  const text: Text = {
    type: 'text',
    value: raw,
    data: { sourceRaw: raw },
    position: node.position,
  };
  parent.children.splice(index, 1, text);
}

export function nonRenderingContextDemotePlugin() {
  return (tree: Root, file: VFile): void => {
    const source = typeof file.value === 'string' ? file.value : String(file.value ?? '');
    if (source.length === 0) return;
    if (!source.includes('<!--') && !/<(pre|code)[\s/>]/i.test(source)) return;

    const masked = maskNonRenderingContexts(source);

    const visit = (parent: Parent): void => {
      for (let index = parent.children.length - 1; index >= 0; index--) {
        const child = parent.children[index];
        if (!child) continue;
        if ('children' in child && Array.isArray(child.children)) {
          visit(child as Parent);
        }
        if (!isLinkShaped(child)) continue;
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (start === undefined || end === undefined) continue;
        if (!isNonRenderingRange(source, masked, start, end)) continue;
        demoteInPlace(parent, index, child, source);
      }
    };
    visit(tree);
  };
}
