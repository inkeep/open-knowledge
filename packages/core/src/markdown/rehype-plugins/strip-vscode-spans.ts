
import type { Element, Root } from 'hast';
import type { Plugin } from 'unified';

export const rehypeStripVscodeSpans: Plugin<[], Root> = () => {
  return (tree) => {
    walk(tree);
  };
};

function walk(node: Root | Element): void {
  if (!('children' in node) || !Array.isArray(node.children)) return;

  for (const child of node.children) {
    if ((child as Element).type === 'element') walk(child as Element);
  }

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if ((child as Element).type !== 'element') continue;
    const el = child as Element;
    if (isVscodeStructuralDiv(el)) {
      node.children[i] = rewriteToPreCode(el);
    }
  }
}

function isVscodeStructuralDiv(el: Element): boolean {
  if (el.tagName !== 'div') return false;
  const childDivs = el.children.filter(
    (c) => (c as Element).type === 'element' && (c as Element).tagName === 'div',
  );
  if (childDivs.length < 2) return false;
  return childDivs.some((div) => hasInlineColorSpan(div as Element));
}

function hasInlineColorSpan(el: Element): boolean {
  for (const c of el.children) {
    if ((c as Element).type !== 'element') continue;
    const inner = c as Element;
    const style = inner.properties?.style;
    if (typeof style === 'string' && /color\s*:/i.test(style)) return true;
    if (hasInlineColorSpan(inner)) return true;
  }
  return false;
}

function rewriteToPreCode(container: Element): Element {
  const lines: string[] = container.children
    .filter((c) => (c as Element).type === 'element' && (c as Element).tagName === 'div')
    .map((div) => collectText(div as Element));
  const code: Element = {
    type: 'element',
    tagName: 'code',
    properties: {},
    children: [{ type: 'text', value: lines.join('\n') }],
  };
  return {
    type: 'element',
    tagName: 'pre',
    properties: {},
    children: [code],
  };
}

function collectText(el: Element): string {
  let out = '';
  for (const c of el.children) {
    if ((c as { type: string; value?: string }).type === 'text') {
      out += (c as { value?: string }).value ?? '';
    } else if ((c as Element).type === 'element') {
      out += collectText(c as Element);
    }
  }
  return out;
}
