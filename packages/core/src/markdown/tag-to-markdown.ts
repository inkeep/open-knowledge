import type { Handle as ToMarkdownHandle } from 'mdast-util-to-markdown';
import type { Processor } from 'unified';
import type { TagMdast } from './mdast-augmentation.ts';

const tagHandler: ToMarkdownHandle = (node) => {
  const tag = node as unknown as TagMdast;
  return `#${tag.value}`;
};

export const tagToMarkdown: {
  handlers: Record<string, ToMarkdownHandle>;
  unsafe: Array<{
    character: string;
    inConstruct: string[];
    after?: string;
    before?: string;
  }>;
} = {
  handlers: { tag: tagHandler },
  unsafe: [
    { character: '#', inConstruct: ['phrasing'], before: '\\s', after: '[A-Za-z]|[^\\x00-\\x7F]' },
  ],
};

export function remarkTags(this: Processor) {
  const data = this.data() as { toMarkdownExtensions?: unknown[] };
  data.toMarkdownExtensions ||= [];
  if (!data.toMarkdownExtensions.some((e) => e === tagToMarkdown)) {
    data.toMarkdownExtensions.push(tagToMarkdown);
  }
}
