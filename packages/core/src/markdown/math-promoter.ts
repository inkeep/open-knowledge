
import type { Code, Root } from 'mdast';
import type { Math as MdastMath } from 'mdast-util-math';
import type { MdxJsxAttribute, MdxJsxFlowElement } from 'mdast-util-mdx';
import { visit } from 'unist-util-visit';

function buildMathElement(
  componentName: 'DollarMath' | 'MathFence',
  formula: string,
  position: MdastMath['position'] | Code['position'],
): MdxJsxFlowElement {
  const attrs: MdxJsxAttribute[] = [{ type: 'mdxJsxAttribute', name: 'formula', value: formula }];

  const element: MdxJsxFlowElement = {
    type: 'mdxJsxFlowElement',
    name: componentName,
    attributes: attrs,
    children: [],
  };
  if (position) {
    element.position = position;
  }
  return element;
}

export function mathPromoterPlugin() {
  return (tree: Root) => {
    visit(tree, 'math', (node: MdastMath, index, parent) => {
      if (!parent || index === undefined || index === null) return;
      const formula = typeof node.value === 'string' ? node.value : '';
      const element = buildMathElement('DollarMath', formula, node.position);
      (parent.children as unknown[])[index] = element;
    });

    visit(tree, 'code', (node: Code, index, parent) => {
      if (!parent || index === undefined || index === null) return;
      if (node.lang !== 'math') return;
      const formula = typeof node.value === 'string' ? node.value : '';
      const element = buildMathElement('MathFence', formula, node.position);
      (parent.children as unknown[])[index] = element;
    });
  };
}
