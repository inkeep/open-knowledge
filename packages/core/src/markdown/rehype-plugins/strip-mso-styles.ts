
import type { Comment, Element, ElementContent, Root } from 'hast';
import type { Plugin } from 'unified';

const OFFICE_NAMESPACES = ['o:', 'w:', 'm:', 'v:', 'u1:'];
const MSO_CLASS_RE = /^Mso[A-Z]/;
const IE_CONDITIONAL_COMMENT_RE = /^\s*\[if\s+[^\]]*\]/;

export const rehypeStripMsoStyles: Plugin<[], Root> = () => {
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
    if ((c as Comment).type === 'comment') {
      const value = String((c as Comment).value ?? '');
      if (IE_CONDITIONAL_COMMENT_RE.test(value)) return [];
      return [c as ElementContent];
    }
    if ((c as Element).type !== 'element') return [c as ElementContent];
    const el = c as Element;
    if (isOfficeNamespaced(el)) return [];
    stripMsoAttributes(el);
    return [el];
  });
}

function isOfficeNamespaced(el: Element): boolean {
  return OFFICE_NAMESPACES.some((prefix) => el.tagName.startsWith(prefix));
}

function stripMsoAttributes(el: Element): void {
  const props = el.properties;
  if (!props) return;

  const className = props.className;
  if (Array.isArray(className)) {
    const filtered = className.filter((c) => typeof c === 'string' && !MSO_CLASS_RE.test(c));
    if (filtered.length === 0) {
      delete props.className;
    } else {
      props.className = filtered;
    }
  } else if (typeof className === 'string' && MSO_CLASS_RE.test(className)) {
    delete props.className;
  }

  const style = props.style;
  if (typeof style === 'string' && /mso-/i.test(style)) {
    delete props.style;
  }

  for (const key of Object.keys(props)) {
    if (key.startsWith('xmlns:')) {
      const ns = key.slice('xmlns:'.length);
      if (OFFICE_NAMESPACES.some((p) => p === `${ns}:`)) {
        delete props[key];
      }
    }
  }
}
