
import type { Image, Paragraph, Root } from 'mdast';
import type { MdxJsxAttribute, MdxJsxFlowElement } from 'mdast-util-mdx';
import { visit } from 'unist-util-visit';

export function imagePromoterPlugin() {
  return (tree: Root) => {
    visit(tree, 'paragraph', (node: Paragraph, index, parent) => {
      if (!parent || index === undefined || index === null) return;

      if (node.children.length !== 1) return;
      const child = node.children[0];
      if (!child || child.type !== 'image') return;

      const image = child as Image;
      const element = buildImageElement(image, node);
      (parent.children as unknown[])[index] = element;
    });
  };
}

function buildImageElement(image: Image, paragraph: Paragraph): MdxJsxFlowElement {
  const attrs: MdxJsxAttribute[] = [{ type: 'mdxJsxAttribute', name: 'src', value: image.url }];
  if (typeof image.alt === 'string') {
    attrs.push({ type: 'mdxJsxAttribute', name: 'alt', value: image.alt });
  }
  if (image.title) {
    attrs.push({ type: 'mdxJsxAttribute', name: 'title', value: image.title });
  }

  const element: MdxJsxFlowElement = {
    type: 'mdxJsxFlowElement',
    name: 'CommonMarkImage',
    attributes: attrs,
    children: [],
  };
  if (paragraph.position) {
    element.position = paragraph.position;
  }
  return element;
}
