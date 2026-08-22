import type { Nodes, Paragraph, Parent, Root, Text } from 'mdast';
import type { MdxJsxAttribute, MdxJsxFlowElement } from 'mdast-util-mdx';
import { visit } from 'unist-util-visit';

type FlowChildren = MdxJsxFlowElement['children'];

const SINGLE_LINE_DETAILS_RE =
  /^<details(\s[^>]*)?>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>\s*$/;

const OPENER_RE = /^<details(\s[^>]*)?>(?:\s*<summary>([\s\S]*?)<\/summary>)?[\s\S]*$/;

const CLOSER_RE = /^\s*<\/details>\s*$/;

/** Attr tokenizer for the opener tag's attr string. Very small: handles
 * boolean shorthand, double-quoted, and single-quoted forms. Sufficient
 * for the attrs Accordion honors (`open`, `name`, `id`). */
function parseDetailsAttrs(rawAttrs: string | undefined): {
  defaultOpen: boolean;
  name: string | null;
  id: string | null;
} {
  let defaultOpen = false;
  let name: string | null = null;
  let id: string | null = null;
  if (!rawAttrs) return { defaultOpen, name, id };

  const attrRe = /(\w+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;
  let m = attrRe.exec(rawAttrs);
  while (m !== null) {
    const attrName = m[1].toLowerCase();
    const attrValue = m[2] ?? m[3] ?? m[4] ?? null;
    if (attrName === 'open') defaultOpen = true;
    else if (attrName === 'name') name = attrValue;
    else if (attrName === 'id') id = attrValue;
    m = attrRe.exec(rawAttrs);
  }
  return { defaultOpen, name, id };
}

function buildAccordionAttrs(opts: {
  title: string | null;
  defaultOpen: boolean;
  name: string | null;
  id: string | null;
}): MdxJsxAttribute[] {
  const attrs: MdxJsxAttribute[] = [];
  if (opts.title !== null) {
    attrs.push({ type: 'mdxJsxAttribute', name: 'title', value: opts.title });
  }
  if (opts.defaultOpen) {
    attrs.push({ type: 'mdxJsxAttribute', name: 'defaultOpen', value: null });
  }
  if (opts.name !== null) {
    attrs.push({ type: 'mdxJsxAttribute', name: 'name', value: opts.name });
  }
  if (opts.id !== null) {
    attrs.push({ type: 'mdxJsxAttribute', name: 'id', value: opts.id });
  }
  return attrs;
}

function isTextOnlyParagraph(node: Nodes): node is Paragraph {
  if (node.type !== 'paragraph') return false;
  const children = (node as Paragraph).children;
  return children.length === 1 && children[0].type === 'text';
}

function textValue(paragraph: Paragraph): string {
  return (paragraph.children[0] as Text).value ?? '';
}

function promoteSingleLineParagraph(paragraph: Paragraph): MdxJsxFlowElement | null {
  if (!isTextOnlyParagraph(paragraph)) return null;
  const value = textValue(paragraph);
  const m = value.match(SINGLE_LINE_DETAILS_RE);
  if (!m) return null;

  const { defaultOpen, name, id } = parseDetailsAttrs(m[1]);
  const title = m[2].trim() || null;
  const bodyText = m[3].trim();

  const children: FlowChildren = bodyText
    ? ([
        { type: 'paragraph', children: [{ type: 'text', value: bodyText }] } satisfies Paragraph,
      ] as FlowChildren)
    : [];

  return {
    type: 'mdxJsxFlowElement',
    name: 'HtmlDetailsAccordion',
    attributes: buildAccordionAttrs({ title, defaultOpen, name, id }),
    children,
    position: paragraph.position,
  };
}

interface OpenerMatch {
  closerIdx: number;
  title: string | null;
  defaultOpen: boolean;
  name: string | null;
  id: string | null;
}

function findOpenerMatch(children: Nodes[], startIdx: number): OpenerMatch | null {
  const opener = children[startIdx];
  if (!isTextOnlyParagraph(opener)) return null;
  const openerText = textValue(opener);
  if (!openerText.startsWith('<details')) return null;
  if (openerText.includes('</details>')) return null;

  const openerMatch = openerText.match(OPENER_RE);
  if (!openerMatch) return null;

  const { defaultOpen, name, id } = parseDetailsAttrs(openerMatch[1]);
  const title = openerMatch[2]?.trim() || null;

  for (let j = startIdx + 1; j < children.length; j++) {
    const candidate = children[j];
    if (!isTextOnlyParagraph(candidate)) continue;
    const candidateText = textValue(candidate);
    if (CLOSER_RE.test(candidateText)) {
      return { closerIdx: j, title, defaultOpen, name, id };
    }
    if (candidateText.includes('</details>')) return null;
  }
  return null;
}

function promoteInParent(parent: Parent): void {
  const children = parent.children as Nodes[];
  let i = 0;
  while (i < children.length) {
    const child = children[i];

    if (isTextOnlyParagraph(child)) {
      const single = promoteSingleLineParagraph(child);
      if (single) {
        (children as unknown[])[i] = single;
        i++;
        continue;
      }

      const match = findOpenerMatch(children, i);
      if (match) {
        const opener = child;
        const closer = children[match.closerIdx];
        const bodyStart = i + 1;
        const bodyEnd = match.closerIdx; // exclusive
        const body = children.slice(bodyStart, bodyEnd) as FlowChildren;

        const openerPos = opener.position;
        const closerPos = closer.position;
        const replacement: MdxJsxFlowElement = {
          type: 'mdxJsxFlowElement',
          name: 'HtmlDetailsAccordion',
          attributes: buildAccordionAttrs(match),
          children: body,
          position:
            openerPos && closerPos
              ? {
                  start: openerPos.start,
                  end: closerPos.end,
                }
              : undefined,
        };

        const removeCount = match.closerIdx - i + 1;
        (children as unknown[]).splice(i, removeCount, replacement);
        i++;
        continue;
      }
    }

    i++;
  }
}

export function detailsAccordionPromoterPlugin() {
  return (tree: Root) => {
    visit(tree, (node) => {
      if ('children' in node && Array.isArray((node as Parent).children)) {
        promoteInParent(node as Parent);
      }
    });
  };
}
