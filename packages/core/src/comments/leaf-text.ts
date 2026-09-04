import type { Node as PMNode } from '@tiptap/pm/model';

function attr(node: PMNode, name: string): string {
  const value = node.attrs[name];
  return typeof value === 'string' ? value : '';
}

function prop(node: PMNode, name: string): string {
  const props = node.attrs.props;
  if (props === null || typeof props !== 'object') return '';
  const value = (props as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

const TEXT_BEARING_PROPS = [
  'children',
  'chart',
  'formula',
  'alt',
  'name',
  'alias',
  'target',
] as const;

function componentText(node: PMNode): string {
  for (const name of TEXT_BEARING_PROPS) {
    const value = prop(node, name);
    if (value.length > 0) return value;
  }
  return attr(node, 'sourceRaw');
}

export function commentLeafText(node: PMNode): string {
  switch (node.type.name) {
    case 'wikiLink':
      return attr(node, 'alias') || attr(node, 'target');
    case 'wikiLinkEmbed':
      return attr(node, 'target');
    case 'tag':
      return `#${attr(node, 'value')}`;
    case 'mathInline':
      return attr(node, 'formula');
    case 'image':
    case 'imageReference':
      return attr(node, 'alt');
    case 'footnoteReference':
      return attr(node, 'label') || attr(node, 'identifier');
    case 'jsxComponent':
    case 'jsxInline':
      return node.content.size === 0 ? componentText(node) : '';
    default:
      return '';
  }
}

export function commentQuoteText(
  doc: PMNode,
  from: number,
  to: number,
  blockSeparator = '\n',
  { inlineOnly = false }: { inlineOnly?: boolean } = {},
): string {
  let text = '';
  let first = true;
  doc.nodesBetween(
    from,
    to,
    (node, pos) => {
      const nodeText = node.isText
        ? (node.text ?? '').slice(Math.max(from, pos) - pos, to - pos)
        : inlineOnly && node.isBlock
          ? ''
          : commentLeafText(node);
      if (node.isBlock && (node.isTextblock || nodeText.length > 0) && blockSeparator) {
        if (first) first = false;
        else text += blockSeparator;
      }
      text += nodeText;
      return true;
    },
    0,
  );
  return text;
}
