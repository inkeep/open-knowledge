
import type { Nodes, Parent, Root } from 'mdast';
import type { MdxJsxTextElement } from 'mdast-util-mdx';
import { visit } from 'unist-util-visit';
import type { UnderlineMdast } from './mdast-augmentation.ts';

const UNDERLINE_TAGS = new Set<string>(['u', 'ins']);

export function underlinePromoterPlugin() {
  return (tree: Root) => {
    visit(tree, 'mdxJsxTextElement', (node: MdxJsxTextElement, index, parent) => {
      if (parent === undefined || index === undefined || index === null) return;
      if (node.name === null || !UNDERLINE_TAGS.has(node.name)) return;
      if ((node.attributes ?? []).length > 0) return;

      const underlineNode: UnderlineMdast = {
        type: 'underline',
        children: (node.children as Nodes[]) ?? [],
        data: { sourceForm: node.name === 'ins' ? 'ins' : 'u' },
      };
      if (node.position) underlineNode.position = node.position;

      const arr = (parent as Parent).children;
      arr.splice(index, 1, underlineNode as unknown as (typeof arr)[number]);
      return index + 1;
    });
  };
}
