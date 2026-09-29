import type { Nodes } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remend from 'remend';
import { unified } from 'unified';

const parser = unified().use(remarkParse).use(remarkGfm);

const CHILD_SEPARATORS: Partial<Record<Nodes['type'], string>> = {
  paragraph: '',
  heading: '',
  tableCell: '',
  emphasis: '',
  strong: '',
  delete: '',
  link: '',
  linkReference: '',
  tableRow: ' | ',
};

function plainText(node: Nodes): string {
  if (node.type === 'break') return '\n';
  if (node.type === 'html') return '';
  if (node.type === 'image') return node.alt ?? '';
  if ('value' in node) return node.value;
  if (!('children' in node)) return '';
  return node.children.map(plainText).join(CHILD_SEPARATORS[node.type] ?? '\n');
}

export function markdownToPlainText(markdown: string): string {
  try {
    return plainText(parser.parse(remend(markdown, { katex: false })))
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .join('\n');
  } catch (err: unknown) {
    console.warn('[markdown-plain-text] markdown parse failed, falling back to raw text', err);
    return markdown;
  }
}
