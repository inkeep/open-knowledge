
import type { Nodes, Paragraph, Parent, Root, Text } from 'mdast';
import type { MdxJsxFlowElement } from 'mdast-util-mdx';
import { visit } from 'unist-util-visit';

const OPENER_RE = /^<(div|center)(\s[^>]*?)?\s*>$/i;

const ALIGN_VALUES = new Set(['center', 'left', 'right', 'justify']);

function extractAlign(rawAttrs: string | undefined): string | null {
  if (!rawAttrs) return null;
  const m = rawAttrs.match(/\balign\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/i);
  if (!m) return null;
  const align = (m[1] ?? m[2] ?? m[3] ?? '').toLowerCase();
  return ALIGN_VALUES.has(align) ? align : null;
}

function isTextOnlyParagraph(node: Nodes): node is Paragraph {
  if (node.type !== 'paragraph') return false;
  const children = (node as Paragraph).children;
  return children.length === 1 && children[0].type === 'text';
}

function textValue(paragraph: Paragraph): string {
  return (paragraph.children[0] as Text).value ?? '';
}

interface OpenerInfo {
  tag: 'div' | 'center';
  align: string | null;
  sourceAttrs: string;
}

function openerInfo(node: Nodes): OpenerInfo | null {
  if (!isTextOnlyParagraph(node)) return null;
  const m = textValue(node).trim().match(OPENER_RE);
  if (!m) return null;
  const tag = m[1].toLowerCase() as 'div' | 'center';
  const sourceAttrs = m[2] ?? '';
  const align = extractAlign(sourceAttrs) ?? (tag === 'center' ? 'center' : null);
  return { tag, align, sourceAttrs };
}

function findCloserIdx(children: Nodes[], startIdx: number, tag: string): number | null {
  const closerRe = new RegExp(String.raw`^\s*</${tag}>\s*$`, 'i');
  for (let j = startIdx + 1; j < children.length; j++) {
    const candidate = children[j];
    if (!isTextOnlyParagraph(candidate)) continue;
    const value = textValue(candidate);
    if (closerRe.test(value)) return j;
    const trimmed = value.trimStart().toLowerCase();
    if (
      trimmed.startsWith('<div') ||
      trimmed.startsWith('<center') ||
      trimmed.includes(`</${tag}>`)
    ) {
      return null;
    }
  }
  return null;
}

function promoteInParent(parent: Parent): void {
  const children = parent.children as Nodes[];
  let i = 0;
  while (i < children.length) {
    const info = openerInfo(children[i]);
    if (info !== null) {
      const closerIdx = findCloserIdx(children, i, info.tag);
      if (closerIdx !== null) {
        const opener = children[i];
        const closer = children[closerIdx];
        const body = children.slice(i + 1, closerIdx) as MdxJsxFlowElement['children'];
        const openerPos = opener.position;
        const closerPos = closer.position;
        const replacement: MdxJsxFlowElement = {
          type: 'mdxJsxFlowElement',
          name: 'HtmlAlignBlock',
          attributes: [
            ...(info.align !== null
              ? [{ type: 'mdxJsxAttribute' as const, name: 'align', value: info.align }]
              : []),
            { type: 'mdxJsxAttribute' as const, name: 'tag', value: info.tag },
            { type: 'mdxJsxAttribute' as const, name: 'sourceAttrs', value: info.sourceAttrs },
          ],
          children: body,
          position:
            openerPos && closerPos ? { start: openerPos.start, end: closerPos.end } : undefined,
        };
        (children as unknown[]).splice(i, closerIdx - i + 1, replacement);
        i++;
        continue;
      }
    }
    i++;
  }
}

export function divAlignPromoterPlugin() {
  return (tree: Root) => {
    visit(tree, (node) => {
      if ('children' in node && Array.isArray((node as Parent).children)) {
        promoteInParent(node as Parent);
      }
    });
  };
}
