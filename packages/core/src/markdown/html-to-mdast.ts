import type { Element as HastElement, Root as HastRoot } from 'hast';
import type { List, Nodes as MdastNodes, Root as MdastRoot } from 'mdast';
import rehypeParse from 'rehype-parse';
import rehypeRemark, { type Options as RehypeRemarkOptions } from 'rehype-remark';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { type Plugin, unified } from 'unified';
import { visit } from 'unist-util-visit';
import { rehypeSkipNotionWhitespace } from './rehype-plugins/skip-notion-whitespace.ts';
import { rehypeStripCocoaMeta } from './rehype-plugins/strip-cocoa-meta.ts';
import { rehypeStripGdocsWrapper } from './rehype-plugins/strip-gdocs-wrapper.ts';
import { rehypeStripGithubHovercard } from './rehype-plugins/strip-github-hovercard.ts';
import { rehypeStripGmailClasses } from './rehype-plugins/strip-gmail-classes.ts';
import { rehypeStripGsheetsWrapper } from './rehype-plugins/strip-gsheets-wrapper.ts';
import { rehypeStripMsoStyles } from './rehype-plugins/strip-mso-styles.ts';
import { rehypeStripSlackClasses } from './rehype-plugins/strip-slack-classes.ts';
import { rehypeStripVscodeSpans } from './rehype-plugins/strip-vscode-spans.ts';
import { flattenTableCellsInTree } from './table-cell-flatten.ts';

interface HtmlToMdastOptions {
  additionalCleanupPlugins?: Plugin[];
  maxBytes?: number;
}

export const HTML_MAX_BYTES = 5 * 1024 * 1024;

export class HtmlPayloadTooLargeError extends Error {
  readonly htmlBytes: number;
  readonly maxBytes: number;
  constructor(htmlBytes: number, maxBytes: number) {
    super(
      `HTML payload (${htmlBytes} bytes) exceeds htmlToMdast ceiling (${maxBytes} bytes); falling through to plain text`,
    );
    this.name = 'HtmlPayloadTooLargeError';
    this.htmlBytes = htmlBytes;
    this.maxBytes = maxBytes;
  }
}

export const cleanupPlugins: Plugin[] = [
  rehypeStripGdocsWrapper as Plugin,
  rehypeStripMsoStyles as Plugin,
  rehypeStripCocoaMeta as Plugin,
  rehypeStripGmailClasses as Plugin,
  rehypeSkipNotionWhitespace as Plugin,
  rehypeStripVscodeSpans as Plugin,
  rehypeStripGsheetsWrapper as Plugin,
  rehypeStripSlackClasses as Plugin,
  rehypeStripGithubHovercard as Plugin,
];

function applyCanonicalSourceFormDefaults(tree: MdastRoot): void {
  visit(tree, (node) => {
    if (node.type === 'strong') {
      node.data ??= {};
      node.data.sourceDelimiter = '**';
    } else if (node.type === 'emphasis') {
      node.data ??= {};
      node.data.sourceDelimiter = '*';
    } else if (node.type === 'inlineCode') {
      node.data ??= {};
      node.data.sourceFenceChar = '`';
      node.data.sourceFenceLength = 1;
    } else if (node.type === 'code') {
      node.data ??= {};
      node.data.sourceFenceChar = '`';
      node.data.sourceFenceLength = 3;
    }
  });
}

function normalizeListSpread(tree: MdastRoot): void {
  visit(tree, 'list', (list: List) => {
    for (const item of list.children) {
      const nonListBlocks = item.children.filter((child) => child.type !== 'list').length;
      item.spread = item.spread === true && nonListBlocks > 1;
    }
    list.spread = list.children.some((item) => item.spread === true);
  });
}

type RehypeRemarkHandlers = NonNullable<RehypeRemarkOptions['handlers']>;
type RehypeRemarkHandler = NonNullable<RehypeRemarkHandlers[string]>;

const underlineElementHandlers: RehypeRemarkHandlers = {
  u: underlineWrapperHandler('u'),
  ins: underlineWrapperHandler('ins'),
};

const UNDERLINE_FORM_KEY = 'okUnderlineForm';

function underlineWrapperHandler(tag: 'u' | 'ins'): RehypeRemarkHandler {
  return (state, node) => {
    const result = {
      type: 'emphasis',
      children: state.all(node as HastElement),
      data: { [UNDERLINE_FORM_KEY]: tag },
    } as unknown as MdastNodes;
    state.patch(node, result);
    return result;
  };
}

function expandUnderlineWrappers(tree: MdastRoot): void {
  const walk = (node: { children?: MdastNodes[] }): void => {
    if (!Array.isArray(node.children)) return;
    for (const child of node.children) walk(child as { children?: MdastNodes[] });
    const next: MdastNodes[] = [];
    for (const child of node.children) {
      const form = (child as { data?: Record<string, unknown> }).data?.[UNDERLINE_FORM_KEY];
      const children = (child as { children?: MdastNodes[] }).children;
      if ((form === 'u' || form === 'ins') && Array.isArray(children)) {
        next.push({ type: 'html', value: `<${form}>` } as MdastNodes);
        next.push(...children);
        next.push({ type: 'html', value: `</${form}>` } as MdastNodes);
        continue;
      }
      next.push(child);
    }
    node.children = next;
  };
  walk(tree as { children?: MdastNodes[] });
}

export function htmlToMdast(html: string, options?: HtmlToMdastOptions): MdastRoot {
  const maxBytes = options?.maxBytes ?? HTML_MAX_BYTES;
  if (html.length > maxBytes) {
    throw new HtmlPayloadTooLargeError(html.length, maxBytes);
  }

  const processor = unified().use(rehypeParse, { fragment: true });

  for (const plugin of cleanupPlugins) {
    processor.use(plugin);
  }
  for (const plugin of options?.additionalCleanupPlugins ?? []) {
    processor.use(plugin);
  }

  processor.use(rehypeRemark, { handlers: underlineElementHandlers });

  const hastTree = processor.parse(html) as HastRoot;
  const mdast = processor.runSync(hastTree) as unknown as MdastRoot;
  normalizeListSpread(mdast);
  expandUnderlineWrappers(mdast);
  applyCanonicalSourceFormDefaults(mdast);
  return mdast;
}

export function mdastToMarkdown(tree: MdastRoot): string {
  flattenTableCellsInTree(tree);
  return String(
    unified()
      .use(remarkGfm)
      .use(remarkStringify, { bullet: '-', rule: '-', fences: true })
      .stringify(tree),
  );
}
