
import type { Element, Root as HastRoot } from 'hast';
import type { Root as MdastRoot } from 'mdast';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import rehypeStringify from 'rehype-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { type Plugin, unified } from 'unified';
import { visit } from 'unist-util-visit';
import { decodeEntityRefs } from './entity-ref-guard.ts';
import { customNodeHandlers } from './mdast-to-hast-handlers.ts';
import { remarkMdxAgnostic } from './remark-mdx-agnostic.ts';
import { isSafeUrl } from './safe-url.ts';
import { remarkWikiLink } from './wiki-link-micromark.ts';

const DANGEROUS_STYLE_URL_RE = /url\s*\(\s*['"]?\s*(?:javascript|vbscript|data)\s*:/i;
const DANGEROUS_STYLE_EXPRESSION_RE = /\bexpression\s*\(/i;
const MAX_STYLE_SCAN_LEN = 10_000;

function isStyleValueSafe(value: string): boolean {
  if (value.length > MAX_STYLE_SCAN_LEN) return false;
  if (DANGEROUS_STYLE_URL_RE.test(value)) return false;
  if (DANGEROUS_STYLE_EXPRESSION_RE.test(value)) return false;
  return true;
}

function isSrcsetValueSafe(srcset: string): boolean {
  for (const raw of srcset.split(',')) {
    const candidate = raw.trim();
    if (candidate === '') continue;
    const url = candidate.split(/\s+/)[0] ?? '';
    if (!isSafeUrl(url)) return false;
  }
  return true;
}

const DECODE_ATTRS_BY_TAG: Record<string, readonly string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  video: ['src', 'title'],
  audio: ['src', 'title'],
  code: ['className'],
};

const URL_ATTRS = new Set(['href', 'src']);

const NORMALIZED_EMPTY_ANGLE_DEST = normalizeUri('<>');

const rehypeDecodeSourcePreservedAttrs: Plugin<[], HastRoot> = () => {
  return (tree) => {
    visit(tree, 'element', (node: Element) => {
      const attrs = DECODE_ATTRS_BY_TAG[node.tagName.toLowerCase()];
      const props = node.properties;
      if (!attrs || !props) return;
      for (const key of attrs) {
        const value = props[key];
        if (Array.isArray(value)) {
          const decodedItems = value.map((item) =>
            typeof item === 'string' ? decodeEntityRefs(item) : item,
          );
          if (decodedItems.some((item, i) => item !== value[i])) {
            props[key] = decodedItems;
          }
          continue;
        }
        if (typeof value !== 'string') continue;
        let decoded: string;
        if (URL_ATTRS.has(key)) {
          if (value === '<>' || value === NORMALIZED_EMPTY_ANGLE_DEST) {
            decoded = '';
          } else {
            const chars = decodeEntityRefs(value);
            decoded = chars === value ? value : normalizeUri(chars);
          }
        } else {
          decoded = decodeEntityRefs(value);
        }
        if (decoded !== value) props[key] = decoded;
      }
    });
  };
};

const rehypeSanitizeUrls: Plugin<[], HastRoot> = () => {
  return (tree) => {
    visit(tree, 'element', (node: Element) => {
      const tag = node.tagName.toLowerCase();
      const props = node.properties;
      if (!props) return;
      if (tag === 'a' || tag === 'area' || tag === 'link' || tag === 'base') {
        const href = props.href;
        if (typeof href === 'string' && !isSafeUrl(href)) {
          delete props.href;
        }
      }
      if (
        tag === 'img' ||
        tag === 'iframe' ||
        tag === 'script' ||
        tag === 'embed' ||
        tag === 'source' ||
        tag === 'audio' ||
        tag === 'video' ||
        tag === 'track'
      ) {
        const src = props.src;
        if (typeof src === 'string' && !isSafeUrl(src)) {
          delete props.src;
        }
      }
      if (tag === 'form') {
        const action = props.action;
        if (typeof action === 'string' && !isSafeUrl(action)) {
          delete props.action;
        }
      }
      if (tag === 'img' || tag === 'source') {
        const srcSet = props.srcSet;
        if (typeof srcSet === 'string' && !isSrcsetValueSafe(srcSet)) {
          delete props.srcSet;
        }
        const srcsetLower = (props as Record<string, unknown>).srcset;
        if (typeof srcsetLower === 'string' && !isSrcsetValueSafe(srcsetLower)) {
          delete (props as Record<string, unknown>).srcset;
        }
      }
      if (tag === 'video') {
        const poster = props.poster;
        if (typeof poster === 'string' && !isSafeUrl(poster)) {
          delete props.poster;
        }
      }
      const style = props.style;
      if (typeof style === 'string' && !isStyleValueSafe(style)) {
        delete props.style;
      }
    });
  };
};

export function mdastToHtml(tree: MdastRoot): string {
  const processor = unified()
    .use(remarkRehype, { handlers: customNodeHandlers })
    .use(rehypeDecodeSourcePreservedAttrs)
    .use(rehypeSanitizeUrls)
    .use(rehypeStringify);
  const hast = processor.runSync(tree) as unknown as HastRoot;
  return String(processor.stringify(hast));
}

export function markdownToHtml(md: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkMdxAgnostic)
    .use(remarkGfm)
    .use(remarkWikiLink)
    .use(remarkRehype, { handlers: customNodeHandlers })
    .use(rehypeDecodeSourcePreservedAttrs)
    .use(rehypeSanitizeUrls)
    .use(rehypeStringify);
  return String(processor.processSync(md));
}
