import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString as mdastToString } from 'mdast-util-to-string';

export function headingContentIdentity(heading: string): string {
  const singleLine = heading.replace(/\s+/g, ' ').trim();
  const tree = fromMarkdown(`## ${singleLine}`);
  const node = tree.children[0];
  if (node === undefined || node.type !== 'heading') return '';
  return mdastToString(node, { includeHtml: false }).replace(/\s+/g, ' ').trim().normalize('NFC');
}
