
import type { Code, Root } from 'mdast';
import type { MdxJsxAttribute, MdxJsxFlowElement } from 'mdast-util-mdx';
import { visit } from 'unist-util-visit';

function buildMermaidFenceElement(chart: string, position: Code['position']): MdxJsxFlowElement {
  const attrs: MdxJsxAttribute[] = [{ type: 'mdxJsxAttribute', name: 'chart', value: chart }];
  const element: MdxJsxFlowElement = {
    type: 'mdxJsxFlowElement',
    name: 'MermaidFence',
    attributes: attrs,
    children: [],
  };
  if (position) {
    element.position = position;
  }
  return element;
}

export function mermaidPromoterPlugin() {
  return (tree: Root) => {
    visit(tree, 'code', (node: Code, index, parent) => {
      if (!parent || index === undefined || index === null) return;
      if (node.lang !== 'mermaid') return;
      const chart = typeof node.value === 'string' ? node.value : '';
      const element = buildMermaidFenceElement(chart, node.position);
      (parent.children as unknown[])[index] = element;
    });
  };
}
