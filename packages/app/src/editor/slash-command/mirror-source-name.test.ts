import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { describe, expect, test } from 'vitest';
import { nextMirrorSourceName } from './mirror-source-name.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

function docFor(markdown: string): PmNode {
  return schema.nodeFromJSON(mdManager.parse(markdown));
}

function nameAtEnd(markdown: string): string {
  const doc = docFor(markdown);
  return nextMirrorSourceName(doc, doc.content.size);
}

function endOfParagraph(doc: PmNode, text: string): number {
  let end = -1;
  doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && node.textContent === text) end = pos + node.nodeSize;
  });
  if (end < 0) throw new Error(`no paragraph reading ${text}`);
  return end;
}

describe('nextMirrorSourceName', () => {
  test('names a new source after the heading above it', () => {
    expect(nameAtEnd('# Pricing\n\n## Plans\n\nWhat each plan includes.\n')).toBe('plans');
  });

  test('only a heading above the insertion point counts', () => {
    const doc = docFor('## Above\n\nFirst.\n\n## Below\n\nSecond.\n');
    expect(nextMirrorSourceName(doc, endOfParagraph(doc, 'First.'))).toBe('above');
  });

  test('falls back to `source` when no heading comes before it', () => {
    expect(nameAtEnd('Just a paragraph.\n')).toBe('source');
  });

  test('numbers a name another source in the doc already uses', () => {
    expect(
      nameAtEnd('## Plans\n\n<MirrorSource name="plans">\n\nStarter is free.\n\n</MirrorSource>\n'),
    ).toBe('plans-1');
  });

  test('counts a source written with the older `id` spelling as taken', () => {
    expect(
      nameAtEnd(
        '## Plans\n\n<MirrorSource id="plans">\n\nStarter is free.\n\n</MirrorSource>\n\n<MirrorSource name="plans-1">\n\nTeam is $8.\n\n</MirrorSource>\n',
      ),
    ).toBe('plans-2');
  });

  test('keeps a name from a long heading short, cutting at a word', () => {
    expect(nameAtEnd('## Compare enterprise licensing and procurement options\n\nText.\n')).toBe(
      'compare-enterprise-licensing-and',
    );
  });

  test('counts a source whose name is written as a number as taken', () => {
    expect(nameAtEnd('## 7\n\n<MirrorSource name={7}>\n\nSeven.\n\n</MirrorSource>\n')).toBe('7-1');
  });

  test('keeps letters from any script', () => {
    expect(nameAtEnd('## 常见问题\n\nText.\n')).toBe('常见问题');
  });
});
