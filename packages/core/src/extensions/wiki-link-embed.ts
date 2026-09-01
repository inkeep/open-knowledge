import { Node } from '@tiptap/core';
import { IMAGE_EXTENSIONS } from '../constants/upload.ts';
import { extensionOf } from '../utils/extension.ts';
import { renderInlineObjectText } from './input-rule-text.ts';
import { normalizeNullableString } from './wiki-link.ts';

export interface WikiLinkEmbedAttrs {
  target: string;
  alias: string | null;
  anchor: string | null;
  resolvedSrc: string | null;
}

function labelFor(attrs: Pick<WikiLinkEmbedAttrs, 'target' | 'alias' | 'anchor'>): string {
  if (attrs.alias) return attrs.alias;
  return attrs.anchor ? `${attrs.target}#${attrs.anchor}` : attrs.target;
}

export const WikiLinkEmbed = Node.create({
  name: 'wikiLinkEmbed',
  group: 'inline',
  inline: true,
  atom: true,
  priority: 60,

  renderText: renderInlineObjectText,

  addAttributes() {
    return {
      target: { default: '' },
      alias: { default: null },
      anchor: { default: null },
      resolvedSrc: {
        default: null,
        rendered: false,
        parseHTML: () => null,
      },
    };
  },

  parseHTML() {
    const getAttrs = (node: HTMLElement | string) => {
      if (typeof node === 'string') return false;
      if (!node.hasAttribute('data-wiki-embed')) return false;
      return {
        target: node.getAttribute('data-target') || '',
        alias: normalizeNullableString(node.getAttribute('data-alias')),
        anchor: normalizeNullableString(node.getAttribute('data-anchor')),
      };
    };
    return [
      { tag: 'img[data-wiki-embed]', getAttrs, priority: 100 },
      { tag: 'a[data-wiki-embed]', getAttrs, priority: 100 },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const target = String(node.attrs.target ?? '');
    const alias = normalizeNullableString(node.attrs.alias);
    const anchor = normalizeNullableString(node.attrs.anchor);
    const resolvedSrc = normalizeNullableString(node.attrs.resolvedSrc);
    const ext = extensionOf(target);

    if (IMAGE_EXTENSIONS.has(ext)) {
      return [
        'img',
        {
          ...HTMLAttributes,
          'data-wiki-embed': '',
          'data-target': target,
          'data-alias': alias ?? '',
          'data-anchor': anchor ?? '',
          src: resolvedSrc ?? target,
          alt: alias ?? target,
        },
      ];
    }

    const hrefBase = resolvedSrc ?? target;
    return [
      'a',
      {
        ...HTMLAttributes,
        'data-wiki-embed': '',
        'data-target': target,
        'data-alias': alias ?? '',
        'data-anchor': anchor ?? '',
        href: anchor ? `${hrefBase}#${anchor}` : hrefBase,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      labelFor({ target, alias, anchor }),
    ];
  },
});
