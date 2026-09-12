import type { JSONContent } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { sharedExtensions } from '../extensions/shared.ts';
import { MarkdownManager } from './index.ts';

const md = new MarkdownManager({ extensions: sharedExtensions });
const resolveEmbed = (target: string): string | null =>
  target === 'pic.png' ? 'assets/pic.png' : null;
const bound = md.withParseContext({ resolveEmbed, sourcePath: 'notes/meeting' });

function embedSrcs(node: JSONContent, out: string[] = []): string[] {
  const componentName = node.attrs?.componentName;
  if (typeof componentName === 'string' && componentName.startsWith('WikiEmbed')) {
    out.push(String((node.attrs?.props as { src?: unknown } | undefined)?.src));
  }
  for (const mark of node.marks ?? []) {
    if (mark.attrs?.sourceForm === 'wikiembed') out.push(String(mark.attrs.href));
  }
  for (const child of node.content ?? []) embedSrcs(child, out);
  return out;
}

describe('MarkdownManager.withParseContext', () => {
  test('a bound view resolves a bare embed through its resolver', () => {
    expect(embedSrcs(bound.parse('![[pic.png]]\n'))).toEqual(['/assets/pic.png']);
  });

  test('the source-map parse a projection is built from resolves too', () => {
    const { doc } = bound.parseWithSourceMapOrFallback('# Title\n\n![[pic.png]]\n');
    expect(embedSrcs(doc.toJSON() as JSONContent)).toEqual(['/assets/pic.png']);
  });

  test('an inline embed resolves its link href', () => {
    expect(embedSrcs(bound.parse('See ![[pic.png]] here.\n'))).toEqual(['/assets/pic.png']);
  });

  test('an unknown target keeps its written name', () => {
    expect(embedSrcs(bound.parse('![[other.png]]\n'))).toEqual(['other.png']);
  });

  test('the manager it was bound from stays unresolved', () => {
    bound.parse('![[pic.png]]\n');
    expect(embedSrcs(md.parse('![[pic.png]]\n'))).toEqual(['pic.png']);
  });

  test('resolution never reaches the bytes', () => {
    const source = '# Title\n\n![[pic.png]]\n\nSee ![[pic.png|alias]] here.\n';
    expect(md.serialize(bound.parse(source))).toBe(md.serialize(md.parse(source)));
  });
});
