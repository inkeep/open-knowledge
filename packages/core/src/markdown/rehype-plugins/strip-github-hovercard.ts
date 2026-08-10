import type { Element, Root } from 'hast';
import type { Plugin } from 'unified';

const GITHUB_CLASS_SET = new Set(['commit-link', 'user-mention', 'team-mention', 'issue-link']);

export const rehypeStripGithubHovercard: Plugin<[], Root> = () => {
  return (tree) => {
    walk(tree);
  };
};

function walk(node: Root | Element): void {
  if (!('children' in node) || !Array.isArray(node.children)) return;

  for (const child of node.children) {
    if ((child as Element).type === 'element') walk(child as Element);
  }

  for (const child of node.children) {
    if ((child as Element).type === 'element') {
      stripGithubHovercardAttrs(child as Element);
    }
  }
}

function stripGithubHovercardAttrs(el: Element): void {
  if (!el.properties) return;
  for (const key of Object.keys(el.properties)) {
    if (key.startsWith('dataHovercard')) {
      delete el.properties[key];
    }
  }
  const cls = el.properties.className;
  if (Array.isArray(cls)) {
    const filtered = cls.filter((c) => !GITHUB_CLASS_SET.has(String(c)));
    if (filtered.length === 0) {
      delete el.properties.className;
    } else {
      el.properties.className = filtered;
    }
  }
}
