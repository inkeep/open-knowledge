import type { Comment, Element, ElementContent, Properties } from 'hast';
import type { FootnoteDefinition, FootnoteReference } from 'mdast';
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx';
import type { Handler, Handlers } from 'mdast-util-to-hast';
import { builtInComponents } from '../registry/built-ins.ts';
import type { CompatMeta } from '../registry/types.ts';
import { wikiLinkHref } from '../utils/slug.ts';
import type {
  MarkMdast,
  PromotedMdastType,
  RawMdxFallbackMdast,
  TagMdast,
  WikiLinkEmbedMdast,
  WikiLinkMdast,
} from './mdast-augmentation.ts';

const HTML_PRIMITIVE_TAGS = new Set(['img', 'video', 'audio', 'mark']);

const compatPrimitiveByName: ReadonlyMap<string, CompatMeta> = new Map(
  builtInComponents.flatMap((meta) =>
    meta.surface === 'compat' && HTML_PRIMITIVE_TAGS.has(meta.rendersAs)
      ? [[meta.name, meta] as const]
      : [],
  ),
);

function collectStaticJsxAttributes(
  node: MdxJsxFlowElement | MdxJsxTextElement,
): Record<string, string | true> | null {
  const bag: Record<string, string | true> = {};
  for (const attr of node.attributes) {
    if (attr.type !== 'mdxJsxAttribute') return null;
    const lowerName = attr.name.toLowerCase();
    if (lowerName.length >= 3 && lowerName.startsWith('on')) continue;
    if (attr.value === null) {
      bag[attr.name] = true;
    } else if (typeof attr.value === 'string') {
      bag[attr.name] = attr.value;
    } else {
      return null;
    }
  }
  return bag;
}

function tryNativeHtmlPrimitive(node: MdxJsxFlowElement | MdxJsxTextElement): Element | null {
  const name = node.name;
  if (!name || !HTML_PRIMITIVE_TAGS.has(name)) return null;
  const properties = collectStaticJsxAttributes(node);
  if (properties === null) return null;
  return { type: 'element', tagName: name, properties, children: [] };
}

function tryCompatPrimitive(node: MdxJsxFlowElement | MdxJsxTextElement): Element | null {
  const name = node.name;
  if (!name) return null;
  const meta = compatPrimitiveByName.get(name);
  if (!meta) return null;
  const bag = collectStaticJsxAttributes(node);
  if (bag === null) return null;
  const translated = meta.translateProps(bag);
  const properties: Properties = {};
  for (const [key, value] of Object.entries(translated)) {
    if (typeof value === 'string' || typeof value === 'boolean') {
      properties[key] = value;
    }
  }
  return { type: 'element', tagName: meta.rendersAs, properties, children: [] };
}

const wikiLinkHandler: Handler = (state, node) => {
  const wiki = node as WikiLinkMdast;
  const { target, anchor, alias } = wiki.data;
  const result: Element = {
    type: 'element',
    tagName: 'a',
    properties: {
      className: ['wiki-link'],
      dataTarget: target,
      dataAnchor: anchor ?? '',
      dataAlias: alias ?? '',
      href: wikiLinkHref(target, anchor),
    },
    children: wiki.children.length > 0 ? state.all(wiki) : [{ type: 'text', value: wiki.value }],
  };
  state.patch(node, result);
  return state.applyData(node, result);
};

const wikiLinkEmbedHandler: Handler = (state, node) => {
  const embed = node as WikiLinkEmbedMdast;
  const { target, anchor, alias } = embed.data;
  const result: Element = {
    type: 'element',
    tagName: 'a',
    properties: {
      className: ['wiki-embed'],
      dataTarget: target,
      dataAnchor: anchor ?? '',
      dataAlias: alias ?? '',
      href: wikiLinkHref(target, anchor),
    },
    children: embed.children.length > 0 ? state.all(embed) : [{ type: 'text', value: embed.value }],
  };
  state.patch(node, result);
  return state.applyData(node, result);
};

const mdxJsxFlowHandler: Handler = (state, node) => {
  const jsx = node as MdxJsxFlowElement;
  const native = tryNativeHtmlPrimitive(jsx);
  if (native) {
    if (jsx.children.length > 0) {
      native.children = state.all(jsx) as ElementContent[];
    }
    state.patch(node, native);
    return state.applyData(node, native);
  }
  const compat = tryCompatPrimitive(jsx);
  if (compat) {
    state.patch(node, compat);
    const resolved = state.applyData(node, compat) as Element;
    if (resolved.tagName === 'img') {
      return { type: 'element', tagName: 'p', properties: {}, children: [resolved] };
    }
    return resolved;
  }
  const raw = typeof jsx.data?.sourceRaw === 'string' ? jsx.data.sourceRaw : '';
  const code: Element = {
    type: 'element',
    tagName: 'code',
    properties: {},
    children: [{ type: 'text', value: raw }],
  };
  const pre: Element = {
    type: 'element',
    tagName: 'pre',
    properties: { className: ['mdx-component'] },
    children: [code],
  };
  state.patch(node, pre);
  return state.applyData(node, pre);
};

const mdxJsxTextHandler: Handler = (state, node) => {
  const jsx = node as MdxJsxTextElement;
  const native = tryNativeHtmlPrimitive(jsx);
  if (native) {
    if (jsx.children.length > 0) {
      native.children = state.all(jsx) as ElementContent[];
    }
    state.patch(node, native);
    return state.applyData(node, native);
  }
  const compat = tryCompatPrimitive(jsx);
  if (compat) {
    state.patch(node, compat);
    return state.applyData(node, compat);
  }
  const raw = typeof jsx.data?.sourceRaw === 'string' ? jsx.data.sourceRaw : '';
  const span: Element = {
    type: 'element',
    tagName: 'span',
    properties: { className: ['mdx-inline'], dataJsxInline: '' },
    children: [{ type: 'text', value: raw }],
  };
  state.patch(node, span);
  return state.applyData(node, span);
};

const rawMdxFallbackHandler: Handler = (state, node) => {
  const fb = node as RawMdxFallbackMdast;
  const reason = fb.data.reason || 'unknown';
  const raw = fb.value || '';
  const safeReason = reason.replace(/--/g, '\u2014');
  const comment: Comment = {
    type: 'comment',
    value: ` Parse error: ${safeReason} `,
  };
  const code: Element = {
    type: 'element',
    tagName: 'code',
    properties: {},
    children: [{ type: 'text', value: raw }],
  };
  const pre: Element = {
    type: 'element',
    tagName: 'pre',
    properties: {
      className: ['mdx-fallback'],
      dataRawMdxFallback: '',
      dataReason: safeReason,
    },
    children: [code],
  };
  state.patch(node, pre);
  const children: ElementContent[] = [comment, state.applyData(node, pre) as Element];
  return children;
};

const markHandler: Handler = (state, node) => {
  const result: Element = {
    type: 'element',
    tagName: 'mark',
    properties: {},
    children: state.all(node as MarkMdast) as ElementContent[],
  };
  state.patch(node, result);
  return state.applyData(node, result);
};

function mdastTextContent(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const n = node as { type?: string; value?: unknown; children?: unknown };
  if (typeof n.value === 'string') return n.value;
  if (Array.isArray(n.children)) {
    return (n.children as unknown[]).map(mdastTextContent).join('');
  }
  return '';
}

const commentHandler: Handler = (state, node) => {
  const safeValue = mdastTextContent(node).replace(/--/g, '—');
  const result: Comment = { type: 'comment', value: safeValue };
  state.patch(node, result);
  return state.applyData(node, result);
};

const commentBlockHandler: Handler = (state, node) => {
  const safeValue = mdastTextContent(node).replace(/--/g, '—');
  const result: Comment = { type: 'comment', value: safeValue };
  state.patch(node, result);
  return state.applyData(node, result);
};

const tagHandler: Handler = (state, node) => {
  const tag = node as TagMdast;
  const value = tag.value;
  const result: Element = {
    type: 'element',
    tagName: 'a',
    properties: {
      className: ['tag'],
      dataTag: value,
      href: `#tag/${value}`,
    },
    children: [{ type: 'text', value: `#${value}` }],
  };
  state.patch(node, result);
  return state.applyData(node, result);
};

const footnoteReferenceHandler: Handler = (state, node) => {
  const ref = node as FootnoteReference;
  const id = ref.identifier;
  const result: Element = {
    type: 'element',
    tagName: 'sup',
    properties: {
      id: `fnref-${id}`,
      dataFootnoteRef: '',
      dataFootnoteId: id,
      className: ['footnote-ref'],
    },
    children: [
      {
        type: 'element',
        tagName: 'a',
        properties: { href: `#fn-${id}`, className: ['footnote-ref-link'] },
        children: [{ type: 'text', value: `[${id}]` }],
      },
    ],
  };
  state.patch(node, result);
  return state.applyData(node, result);
};

const footnoteDefinitionHandler: Handler = (state, node) => {
  const def = node as FootnoteDefinition;
  const id = def.identifier;
  const result: Element = {
    type: 'element',
    tagName: 'aside',
    properties: {
      id: `fn-${id}`,
      dataFootnoteDef: '',
      dataFootnoteId: id,
      className: ['footnote-def'],
    },
    children: [
      {
        type: 'element',
        tagName: 'div',
        properties: { className: ['footnote-body'] },
        children: state.all(node) as ElementContent[],
      },
      {
        type: 'element',
        tagName: 'a',
        properties: {
          href: `#fnref-${id}`,
          className: ['footnote-backref'],
          ariaLabel: 'Back to reference',
        },
        children: [{ type: 'text', value: '↩' }],
      },
    ],
  };
  state.patch(node, result);
  return state.applyData(node, result);
};

const promotedHandlers: Record<PromotedMdastType, Handler> = {
  wikiLink: wikiLinkHandler,
  wikiLinkEmbed: wikiLinkEmbedHandler,
  mdxJsxFlowElement: mdxJsxFlowHandler,
  mdxJsxTextElement: mdxJsxTextHandler,
  rawMdxFallback: rawMdxFallbackHandler,
  mark: markHandler,
  tag: tagHandler,
  comment: commentHandler,
  commentBlock: commentBlockHandler,
  footnoteReference: footnoteReferenceHandler,
  footnoteDefinition: footnoteDefinitionHandler,
};

export const customNodeHandlers: Handlers = promotedHandlers;
