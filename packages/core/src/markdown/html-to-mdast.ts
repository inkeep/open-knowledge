import type { Root as HastRoot } from 'hast';
import type { Root as MdastRoot } from 'mdast';
import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
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

  processor.use(rehypeRemark);

  const hastTree = processor.parse(html) as HastRoot;
  const mdast = processor.runSync(hastTree) as unknown as MdastRoot;
  applyCanonicalSourceFormDefaults(mdast);
  return mdast;
}

export function mdastToMarkdown(tree: MdastRoot): string {
  return String(unified().use(remarkGfm).use(remarkStringify).stringify(tree));
}
