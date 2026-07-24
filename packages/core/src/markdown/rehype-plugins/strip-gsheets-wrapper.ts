
import type { Element, ElementContent, Root } from 'hast';
import type { Plugin } from 'unified';

export const rehypeStripGsheetsWrapper: Plugin<[], Root> = () => {
  return (tree) => {
    walk(tree);
  };
};

function walk(node: Root | Element): void {
  if (!('children' in node) || !Array.isArray(node.children)) return;

  for (const child of node.children) {
    if ((child as Element).type === 'element') walk(child as Element);
  }

  node.children = node.children.flatMap((c): ElementContent[] => {
    if ((c as Element).type !== 'element') return [c as ElementContent];
    const el = c as Element;
    if (el.tagName === 'google-sheets-html-origin') {
      return el.children as ElementContent[];
    }
    if (el.tagName === 'style') return [];
    stripDataSheetsAttrs(el);
    return [el];
  });
}

function stripDataSheetsAttrs(el: Element): void {
  if (!el.properties) return;
  for (const key of Object.keys(el.properties)) {
    if (key.startsWith('dataSheets')) {
      delete el.properties[key];
    }
  }
}
