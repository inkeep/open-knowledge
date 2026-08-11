
import type { Element, ElementContent, Root } from 'hast';
import type { Plugin } from 'unified';

const SLACK_CLASS_RE = /^c-(message_kit__|message__|compose|timestamp)/;

export const rehypeStripSlackClasses: Plugin<[], Root> = () => {
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
    if (isTimestampSpan(el)) return [];
    stripSlackClasses(el);
    return [el];
  });
}

function isTimestampSpan(el: Element): boolean {
  const cls = el.properties?.className;
  if (!Array.isArray(cls)) return false;
  return cls.some((c) => String(c) === 'c-timestamp' || String(c).startsWith('c-timestamp'));
}

function stripSlackClasses(el: Element): void {
  const cls = el.properties?.className;
  if (!Array.isArray(cls)) return;
  const filtered = cls.filter((c) => !SLACK_CLASS_RE.test(String(c)));
  if (filtered.length === 0) {
    delete el.properties?.className;
  } else if (el.properties) {
    el.properties.className = filtered;
  }
}
