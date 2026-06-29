import type { Nodes, Parent, Root } from 'mdast';
import { SKIP, visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import { promoteInParent } from './autolink-promotion.ts';
import { applyPositionSliceToNode } from './position-slice.ts';
import { promoteTagsInParent } from './tag-promotion.ts';
import { KNOWN_MDAST_TYPES, toRawMdxFallbackMdast } from './unknown-mdast-guard.ts';

export function mergedPostParseWalkerPlugin() {
  return (tree: Root, file: VFile) => {
    const source = typeof file.value === 'string' ? file.value : '';

    const debug = typeof process !== 'undefined' && process.env?.OK_DEBUG_POSITION_SLICE === '1';

    visit(tree, (node, index, parent) => {
      if (
        parent !== undefined &&
        typeof index === 'number' &&
        typeof node.type === 'string' &&
        !KNOWN_MDAST_TYPES.has(node.type)
      ) {
        const replacement = toRawMdxFallbackMdast(node, source);
        (parent.children as unknown[])[index] = replacement;
        return SKIP;
      }

      if ('children' in node && Array.isArray((node as Parent).children)) {
        const parentLike = node as Parent;
        if (parentLike.children.some((c) => c.type === 'text')) {
          promoteInParent(parentLike, source);
          promoteTagsInParent(parentLike, source);
        }
      }

      applyPositionSliceToNode(
        node as Nodes,
        source,
        debug,
        parent as { type?: string } | undefined,
      );

      if (
        node.type === 'heading' &&
        parent !== undefined &&
        typeof index === 'number' &&
        (node as Nodes & { data?: { sourceStyle?: string } }).data?.sourceStyle === 'setext'
      ) {
        const headingEnd = node.position?.end?.line;
        const next = (parent as Parent).children[index + 1] as Nodes | undefined;
        const nextStart = next?.position?.start?.line;
        if (
          next?.type === 'paragraph' &&
          typeof headingEnd === 'number' &&
          typeof nextStart === 'number' &&
          nextStart === headingEnd + 1
        ) {
          const heading = node as Nodes & { data?: { sourceContiguousNext?: boolean } };
          heading.data ??= {};
          heading.data.sourceContiguousNext = true;
        }
      }
    });
  };
}
