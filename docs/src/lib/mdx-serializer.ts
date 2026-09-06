import type { Html, PhrasingContent, Root, RootContent } from 'mdast';
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';

export type ComponentDisposition =
  | 'flatten'
  | 'drop'
  | ((node: MdxJsxNode, api: SerializerApi) => string | null);

export type SerializerRegistry = Readonly<Record<string, ComponentDisposition>>;

export type MdxJsxNode = MdxJsxFlowElement | MdxJsxTextElement;

export interface SerializerApi {
  children(node: MdxJsxNode): string;
  text(node: MdxJsxNode): string;
  attribute(node: MdxJsxNode, name: string): string | undefined;
  expressionAttribute(node: MdxJsxNode, name: string): string | undefined;
  url(href: string): string;
}

export interface SerializeMdxOptions {
  registry: SerializerRegistry;
  pageUrl: string;
}

export interface SerializedMdx {
  frontmatter: Record<string, unknown>;
  body: string;
}

export const STRINGIFY_OPTIONS = {
  bullet: '-',
  rule: '-',
  listItemIndent: 'one',
} as const;

const processor = unified()
  .use(remarkParse)
  .use(remarkMdx)
  .use(remarkGfm)
  .use(remarkStringify, STRINGIFY_OPTIONS);

const proseProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, STRINGIFY_OPTIONS);

const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//;

const SOURCE_EXTENSION = /\.mdx?$/;

const NON_PROSE_TYPES = new Set(['mdxjsEsm', 'mdxFlowExpression', 'mdxTextExpression']);

export function serializeMdx(source: string, options: SerializeMdxOptions): SerializedMdx {
  const { frontmatter, body } = splitFrontmatter(source);
  const base = new URL(options.pageUrl);

  const tree = processor.parse(body);
  absolutiseUrls(tree, base);
  try {
    tree.children = transformChildren(tree, options.registry, base);
  } catch (error) {
    throw new Error(`${options.pageUrl}: ${error instanceof Error ? error.message : error}`, {
      cause: error,
    });
  }

  return { frontmatter, body: processor.stringify(tree).trimEnd() };
}

export function componentNames(source: string): string[] {
  const names = new Set<string>();
  visit(processor.parse(splitFrontmatter(source).body), (node) => {
    if (node.type !== 'mdxJsxFlowElement' && node.type !== 'mdxJsxTextElement') return;
    if (typeof node.name === 'string') names.add(node.name);
  });
  return [...names];
}

export function escapeRawHtml(prose: string, { flattenLinks = false } = {}): string {
  const tree = proseProcessor.parse(prose);
  visit(tree, 'html', (node, index, parent) => {
    if (!parent || index === undefined) return;
    const asText = { type: 'text' as const, value: node.value };
    parent.children[index] =
      parent.type === 'root' || parent.type === 'blockquote' || parent.type === 'listItem'
        ? { type: 'paragraph', children: [asText] }
        : asText;
  });
  if (flattenLinks) flattenLinkNodes(tree);
  return proseProcessor.stringify(tree).trim();
}

function flattenLinkNodes(tree: Root): void {
  visit(tree, (node, index, parent) => {
    if (!parent || index === undefined) return;
    if (node.type === 'link') {
      parent.children.splice(index, 1, ...node.children);
      return index;
    }
    if (node.type === 'image') {
      parent.children[index] = { type: 'text', value: node.alt ?? '' };
    }
  });
}

export function escapeInlineProse(prose: string, options?: { flattenLinks?: boolean }): string {
  return escapeRawHtml(prose.replace(/\s+/g, ' ').trim(), options);
}

export function markdownLink(label: string, url: string, { image = false } = {}): string {
  const children = inlinePhrasing(label);
  const node = image
    ? ({ type: 'image', url, alt: textContent({ children }) } as const)
    : ({ type: 'link', url, children } as const);
  return proseProcessor
    .stringify({ type: 'root', children: [{ type: 'paragraph', children: [node] }] })
    .trim();
}

function inlinePhrasing(markdown: string): PhrasingContent[] {
  const paragraph = singleParagraph(markdown);
  if (paragraph) return paragraph;

  const oneLine = markdown.replace(/\s+/g, ' ').trim();
  const neutralised = oneLine.replace(/^(\d{1,9})([.)])|^[#>*+_=-]+/, (run, digits, delimiter) =>
    digits ? `${digits}\\${delimiter}` : run.replace(/./g, '\\$&'),
  );
  const asInline = singleParagraph(neutralised);
  if (asInline) return asInline;

  return [{ type: 'text', value: textContent(proseProcessor.parse(markdown)) }];
}

function singleParagraph(markdown: string): PhrasingContent[] | null {
  const tree = proseProcessor.parse(markdown);
  flattenLinkNodes(tree);
  const [first, ...rest] = tree.children;
  return first?.type === 'paragraph' && rest.length === 0 ? first.children : null;
}

export function requiredLiteral(node: MdxJsxNode, api: SerializerApi, name: string): string {
  const expression = api.expressionAttribute(node, name);
  if (expression !== undefined) {
    throw new Error(
      `<${node.name} ${name}={${expression}}> carries its value in an expression the Markdown ` +
        'rendition cannot resolve. Write it as a literal, or give the component a disposition ' +
        'that renders what it points at.',
    );
  }

  const literal = api.attribute(node, name);
  if (literal) return literal;

  throw new Error(
    `<${node.name}> has no \`${name}\`, so the Markdown rendition has nothing to render.`,
  );
}

export function longestBacktickRun(value: string): number {
  return Math.max(0, ...[...value.matchAll(/`+/g)].map((run) => run[0].length));
}

export function inlineCodeSpan(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const marker = '`'.repeat(longestBacktickRun(trimmed) + 1);
  const pad = trimmed.startsWith('`') || trimmed.endsWith('`') ? ' ' : '';
  return `${marker}${pad}${trimmed}${pad}${marker}`;
}

function splitFrontmatter(source: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = FRONTMATTER_BLOCK.exec(source);
  if (!match) return { frontmatter: {}, body: source };

  const parsed: unknown = parseYaml(match[1] ?? '') ?? {};
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Frontmatter must be a YAML mapping, got ${Array.isArray(parsed) ? 'a sequence' : typeof parsed}.`,
    );
  }
  return { frontmatter: parsed as Record<string, unknown>, body: source.slice(match[0].length) };
}

function absolutiseUrls(tree: Root, base: URL): void {
  visit(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return;
    node.url = absolutise(node.url, base);
  });
}

function absolutise(url: string, base: URL): string {
  if (url === '' || ABSOLUTE_URL.test(url)) return url;
  const suffixAt = url.search(/[#?]/);
  const path = suffixAt === -1 ? url : url.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? '' : url.slice(suffixAt);
  return new URL(path.replace(SOURCE_EXTENSION, '') + suffix, base).href;
}

function transformChildren(
  parent: { children?: unknown[] },
  registry: SerializerRegistry,
  base: URL,
) {
  const out: RootContent[] = [];
  for (const child of parent.children ?? [])
    out.push(...transformNode(child as RootContent, registry, base));
  return out;
}

function transformNode(node: RootContent, registry: SerializerRegistry, base: URL): RootContent[] {
  if (NON_PROSE_TYPES.has(node.type)) return [];

  if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
    return transformJsx(node, registry, base);
  }

  if ('children' in node) {
    (node as unknown as { children: RootContent[] }).children = transformChildren(
      node,
      registry,
      base,
    );
  }
  return [node];
}

function transformJsx(node: MdxJsxNode, registry: SerializerRegistry, base: URL): RootContent[] {
  const name = node.name;
  if (name === null || name === undefined) return transformChildren(node, registry, base);

  const disposition = Object.hasOwn(registry, name) ? registry[name] : undefined;
  if (disposition === undefined) {
    throw new Error(
      `No serializer disposition for <${name}>. Add "${name}" to the registry as 'flatten', 'drop', or a custom serializer.`,
    );
  }
  if (disposition === 'drop') return [];
  if (disposition === 'flatten') return transformChildren(node, registry, base);

  const rendered = disposition(node, apiFor(registry, base));
  if (rendered === null) return [];
  return [{ type: 'html', value: rendered } satisfies Html];
}

function apiFor(registry: SerializerRegistry, base: URL): SerializerApi {
  return {
    children(node) {
      const children = transformChildren(node, registry, base);
      return processor.stringify({ type: 'root', children }).trimEnd();
    },
    text(node) {
      return textContent(node);
    },
    url(href) {
      return absolutise(href, base);
    },
    attribute(node, name) {
      const found = findAttribute(node, name);
      if (found === undefined) return undefined;
      if (found.value !== null && typeof found.value !== 'string') {
        throw new Error(
          `<${node.name ?? 'component'}> \`${name}\` is an expression, and this serializer reads ` +
            'it as literal text. Read it with expressionAttribute and parse it, or give the ' +
            'attribute a quoted value.',
        );
      }
      return typeof found.value === 'string' ? found.value : undefined;
    },
    expressionAttribute(node, name) {
      const value = findAttribute(node, name)?.value;
      return typeof value === 'object' && value !== null ? value.value : undefined;
    },
  };
}

function findAttribute(node: MdxJsxNode, name: string) {
  return node.attributes.find(
    (attribute) => attribute.type === 'mdxJsxAttribute' && attribute.name === name,
  );
}

function textContent(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const typed = node as { type?: string; value?: unknown; alt?: unknown; children?: unknown[] };
  if (typed.type === 'text' || typed.type === 'inlineCode' || typed.type === 'code') {
    return typeof typed.value === 'string' ? typed.value : '';
  }
  if (typed.type === 'image') return typeof typed.alt === 'string' ? typed.alt : '';
  if (!Array.isArray(typed.children)) return '';
  return typed.children.map(textContent).join('');
}
