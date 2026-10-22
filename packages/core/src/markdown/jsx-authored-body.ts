import type { Node as PmNode } from '@tiptap/pm/model';
import type { Nodes as MdastNodes } from 'mdast';
import type { MdxJsxFlowElement } from 'mdast-util-mdx-jsx';
import { stableStringify } from '../bridge/pm-structural-equivalence.ts';
import { stripMdastPositions } from '../bridge/structural-freshness.ts';
import type { AuthoredJsxBody } from './mdast-augmentation.ts';

type AuthoredJsxSource = { kind: 'verbatim' } | { kind: 'body'; body: AuthoredJsxBody };

export interface AuthoredJsxSourceReader {
  read(
    node: PmNode,
    emitted: MdxJsxFlowElement,
    serialize: (authored: PmNode) => MdastNodes,
  ): AuthoredJsxSource | null;
}

interface AuthoredElement {
  attributes: string;
  children: string;
}

const TAG_NAME_END = /[\s/>{]/;

const AUTHORED_ELEMENT_CACHE_LIMIT = 256;

function canonicalJson(value: unknown): string {
  return stableStringify(stripMdastPositions(value));
}

export function plainJsxFlowElement(
  node: MdastNodes,
  name: string | null,
): MdxJsxFlowElement | null {
  if (node.type !== 'mdxJsxFlowElement') return null;
  return node.name === name && !node.data?.htmlBoundary ? node : null;
}

function splitAuthoredOpenTag(sourceRaw: string, name: string): AuthoredJsxBody | null {
  const start = sourceRaw.indexOf('<');
  if (start < 0 || sourceRaw.slice(0, start).trim() !== '') return null;
  const nameEnd = start + 1 + name.length;
  if (!sourceRaw.startsWith(`<${name}`, start) || !TAG_NAME_END.test(sourceRaw[nameEnd] ?? '')) {
    return null;
  }
  let quote: string | null = null;
  let braceDepth = 0;
  for (let i = nameEnd; i < sourceRaw.length; i++) {
    const ch = sourceRaw[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (braceDepth > 0) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
    } else if (ch === '{') {
      braceDepth = 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      if (sourceRaw[i - 1] === '/') return null;
      const afterOpenTag = sourceRaw.slice(i + 1);
      if (!afterOpenTag.trimEnd().endsWith(`</${name}>`)) return null;
      return { leading: sourceRaw.slice(0, start), afterOpenTag };
    }
  }
  return null;
}

export function createAuthoredJsxSourceReader(
  parse: (sourceRaw: string) => PmNode,
): AuthoredJsxSourceReader {
  const cache = new Map<string, AuthoredElement | null>();

  const describeAuthoredElement = (
    sourceRaw: string,
    name: string,
    serialize: (authored: PmNode) => MdastNodes,
  ): AuthoredElement | null => {
    const doc = parse(sourceRaw);
    const only = doc.childCount === 1 ? doc.firstChild : null;
    if (only?.type.name !== 'jsxComponent' || only.attrs.kind !== 'element') return null;
    const emitted = plainJsxFlowElement(serialize(only), name);
    if (!emitted) return null;
    return {
      attributes: canonicalJson(emitted.attributes),
      children: canonicalJson(emitted.children),
    };
  };

  const authoredElement = (
    sourceRaw: string,
    name: string,
    serialize: (authored: PmNode) => MdastNodes,
  ): AuthoredElement | null => {
    const cached = cache.get(sourceRaw);
    if (cached !== undefined) return cached;
    const value = describeAuthoredElement(sourceRaw, name, serialize);
    if (cache.size >= AUTHORED_ELEMENT_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(sourceRaw, value);
    return value;
  };

  return {
    read(node, emitted, serialize) {
      const { componentName, sourceRaw, kind } = node.attrs;
      if (kind !== 'element' || node.childCount === 0) return null;
      if (typeof componentName !== 'string' || componentName === '') return null;
      if (typeof sourceRaw !== 'string' || sourceRaw === '') return null;
      const body = splitAuthoredOpenTag(sourceRaw, componentName);
      if (!body) return null;
      const authored = authoredElement(sourceRaw, componentName, serialize);
      if (!authored || canonicalJson(emitted.children) !== authored.children) return null;
      return canonicalJson(emitted.attributes) === authored.attributes
        ? { kind: 'verbatim' }
        : { kind: 'body', body };
    },
  };
}
