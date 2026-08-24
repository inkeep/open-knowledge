import type { Element, Root } from 'hast';
import type { Plugin } from 'unified';

const GMAIL_CLASS_RE = /^gmail_/;

export const rehypeStripGmailClasses: Plugin<[], Root> = () => {
  return (tree) => {
    walk(tree);
  };
};

function walk(node: Root | Element): void {
  if (!('children' in node) || !Array.isArray(node.children)) return;

  for (const child of node.children) {
    if ((child as Element).type === 'element') walk(child as Element);
  }

  let i = 0;
  while (i < node.children.length) {
    const child = node.children[i];
    if ((child as Element).type !== 'element') {
      i++;
      continue;
    }
    const el = child as Element;
    if (el.tagName === 'div' && hasGmailClass(el, 'gmail_quote')) {
      el.tagName = 'blockquote';
      stripGmailClasses(el);
    } else {
      stripGmailClasses(el);
    }

    if (isTrivialLtrDiv(el)) {
      node.children.splice(i, 1, ...el.children);
      continue;
    }
    i++;
  }
}

function hasGmailClass(el: Element, name: string): boolean {
  const cls = el.properties?.className;
  if (!Array.isArray(cls)) return false;
  return cls.some((c) => String(c) === name);
}

function stripGmailClasses(el: Element): void {
  const cls = el.properties?.className;
  if (!Array.isArray(cls)) return;
  const filtered = cls.filter((c) => !GMAIL_CLASS_RE.test(String(c)));
  if (filtered.length === 0) {
    delete el.properties?.className;
  } else {
    if (el.properties) el.properties.className = filtered;
  }
}

function isTrivialLtrDiv(el: Element): boolean {
  if (el.tagName !== 'div') return false;
  if (el.properties?.dir !== 'ltr') return false;
  const cls = el.properties?.className;
  if (cls != null && !(Array.isArray(cls) && cls.length === 0)) return false;
  const elChildren = el.children.filter((c) => (c as Element).type === 'element');
  return elChildren.length <= 1;
}
