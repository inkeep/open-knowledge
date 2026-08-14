import type { Element, ElementContent, Root } from 'hast';
import type { Plugin } from 'unified';

const APPLE_CLASSES = new Set(['Apple-tab-span', 'Apple-converted-space', 'Apple-style-span']);

export const rehypeStripCocoaMeta: Plugin<[], Root> = () => {
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
    if (isCocoaMetaGenerator(el)) return [];
    if (isAppleSpan(el)) {
      return el.children as ElementContent[];
    }
    return [el];
  });
}

function isCocoaMetaGenerator(el: Element): boolean {
  if (el.tagName !== 'meta') return false;
  const name = el.properties?.name;
  const content = el.properties?.content;
  return name === 'Generator' && typeof content === 'string' && /Cocoa/i.test(content);
}

function isAppleSpan(el: Element): boolean {
  if (el.tagName !== 'span') return false;
  const className = el.properties?.className;
  if (!Array.isArray(className)) return false;
  return className.length > 0 && className.every((c) => APPLE_CLASSES.has(String(c)));
}
