import { Node } from '@tiptap/core';
import { renderInlineObjectText } from './input-rule-text.ts';

export interface WikiLinkAttrs {
  target: string;
  alias: string | null;
  anchor: string | null;
  resolved: boolean;
}

const WIKI_LINK_PATTERN = /^\[\[([^[\]|#]+?)(?:#([^\]|]+?))?(?:\|([^\]]+?))?\]\]/;

export function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseWikiLink(src: string): {
  type: 'wikilink';
  raw: string;
  target: string;
  alias: string | null;
  anchor: string | null;
} | null {
  const match = src.match(WIKI_LINK_PATTERN);
  if (!match) return null;

  const target = match[1]?.trim() ?? '';
  if (!target) return null;

  return {
    type: 'wikilink',
    raw: match[0],
    target,
    anchor: normalizeNullableString(match[2]),
    alias: normalizeNullableString(match[3]),
  };
}

export function getWikiLinkText(attrs: Pick<WikiLinkAttrs, 'target' | 'alias' | 'anchor'>): string {
  if (attrs.alias) return attrs.alias;
  return attrs.anchor ? `${attrs.target}#${attrs.anchor}` : attrs.target;
}

export function renderWikiLink(attrs: Pick<WikiLinkAttrs, 'target' | 'alias' | 'anchor'>): string {
  let rendered = `[[${attrs.target}`;

  if (attrs.anchor) {
    rendered += `#${attrs.anchor}`;
  }

  if (attrs.alias) {
    rendered += `|${attrs.alias}`;
  }

  return `${rendered}]]`;
}

export const WikiLink = Node.create({
  name: 'wikiLink',
  marks: '_',
  group: 'inline',
  inline: true,
  atom: true,
  priority: 60,

  renderText: renderInlineObjectText,

  addAttributes() {
    return {
      target: {
        default: '',
      },
      alias: {
        default: null,
      },
      anchor: {
        default: null,
      },
      resolved: {
        default: false,
      },
      sourceTarget: {
        default: null,
        rendered: false,
      },
      sourceAnchor: {
        default: null,
        rendered: false,
      },
      sourceAlias: {
        default: null,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-wiki-link]',
        getAttrs: (node) => {
          if (typeof node === 'string') return false;

          return {
            target: node.getAttribute('data-target') || '',
            alias: normalizeNullableString(node.getAttribute('data-alias')),
            anchor: normalizeNullableString(node.getAttribute('data-anchor')),
            resolved: node.getAttribute('data-resolved') === 'true',
          };
        },
      },
      {
        tag: 'a.wiki-link[data-target]',
        priority: 100,
        getAttrs: (node) => {
          if (typeof node === 'string') return false;
          const target = node.getAttribute('data-target') ?? '';
          if (!target) return false;
          return {
            target,
            alias: normalizeNullableString(node.getAttribute('data-alias')),
            anchor: normalizeNullableString(node.getAttribute('data-anchor')),
            resolved: false,
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const target = String(node.attrs.target ?? '');
    const alias = normalizeNullableString(node.attrs.alias);
    const anchor = normalizeNullableString(node.attrs.anchor);
    const resolved = node.attrs.resolved === true;

    return [
      'span',
      {
        ...HTMLAttributes,
        'data-wiki-link': '',
        'data-target': target,
        'data-alias': alias ?? '',
        'data-anchor': anchor ?? '',
        'data-resolved': resolved ? 'true' : 'false',
      },
      getWikiLinkText({ target, alias, anchor }),
    ];
  },
});
