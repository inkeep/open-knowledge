import type { Element, Root } from 'hast';
import type { Plugin } from 'unified';

const GUID_PREFIX = 'docs-internal-guid-';

function unwrap(parent: Element | Root, index: number): void {
  const node = parent.children[index] as Element;
  if (!node || node.type !== 'element') return;
  parent.children.splice(index, 1, ...node.children);
}

export const rehypeStripGdocsWrapper: Plugin<[], Root> = () => {
  return (tree) => {
    walk(tree);
  };
};

function walk(node: Root | Element): void {
  if (!('children' in node) || !Array.isArray(node.children)) return;
  for (const child of node.children) {
    if ((child as Element).type === 'element') {
      walk(child as Element);
    }
  }
  let i = 0;
  while (i < node.children.length) {
    const child = node.children[i];
    if (!child || (child as Element).type !== 'element') {
      i++;
      continue;
    }
    const el = child as Element;
    if (isGdocsIdWrapper(el) || isGdocsLtrDivWrapper(el)) {
      unwrap(node, i);
      continue;
    }
    i++;
  }
}

function isGdocsIdWrapper(el: Element): boolean {
  if (el.tagName !== 'b') return false;
  const id = el.properties?.id;
  return typeof id === 'string' && id.startsWith(GUID_PREFIX);
}

function isGdocsLtrDivWrapper(el: Element): boolean {
  if (el.tagName !== 'div') return false;
  if (el.properties?.dir !== 'ltr') return false;
  const elementChildren = el.children.filter((c) => (c as Element).type === 'element') as Element[];
  if (elementChildren.length !== 1) return false;
  return elementChildren[0]?.tagName === 'table';
}
