import { describe, expect, test } from 'vitest';
import { getSharedMarkdownManager } from '../utils/md-singleton.ts';
import { listMirrorSources } from './mirror-source-names.ts';
import type { MdastNodeLike } from './use-mirror-source.ts';

function treeOf(markdown: string): MdastNodeLike {
  return getSharedMarkdownManager().parseToMdast(markdown) as MdastNodeLike;
}

describe('listMirrorSources', () => {
  test('lists each source in document order with a plain-text preview', () => {
    const tree = treeOf(
      [
        '# Pricing',
        '',
        '<MirrorSource name="plans">',
        '',
        'Starter is **free**. Team is $8 per seat.',
        '',
        '</MirrorSource>',
        '',
        '<MirrorSource name="faq">',
        '',
        '- Can I switch plans?',
        '',
        '</MirrorSource>',
      ].join('\n'),
    );
    expect(listMirrorSources(tree)).toEqual([
      { name: 'plans', preview: 'Starter is free. Team is $8 per seat.' },
      { name: 'faq', preview: 'Can I switch plans?' },
    ]);
  });

  test('includes a source written with the older `id` spelling', () => {
    const tree = treeOf('<MirrorSource id="plans">\n\nStarter is free.\n\n</MirrorSource>\n');
    expect(listMirrorSources(tree)).toEqual([{ name: 'plans', preview: 'Starter is free.' }]);
  });

  test('lists a repeated name once, as the first source carrying it', () => {
    const tree = treeOf(
      '<MirrorSource name="plans">\n\nFirst.\n\n</MirrorSource>\n\n<MirrorSource name="plans">\n\nSecond.\n\n</MirrorSource>\n',
    );
    expect(listMirrorSources(tree)).toEqual([{ name: 'plans', preview: 'First.' }]);
  });

  test('reads a name written as an expression the way the editor does', () => {
    const tree = treeOf(
      '<MirrorSource name={42}>\n\nForty-two.\n\n</MirrorSource>\n\n<MirrorSource name={"plans"}>\n\nStarter is free.\n\n</MirrorSource>\n',
    );
    expect(listMirrorSources(tree).map((entry) => entry.name)).toEqual(['42', 'plans']);
  });

  test('skips a source without a name', () => {
    const tree = treeOf('<MirrorSource>\n\nNameless.\n\n</MirrorSource>\n');
    expect(listMirrorSources(tree)).toEqual([]);
  });

  test('shortens a long preview', () => {
    const long = 'word '.repeat(40).trim();
    const tree = treeOf(`<MirrorSource name="long">\n\n${long}\n\n</MirrorSource>\n`);
    const [entry] = listMirrorSources(tree);
    expect(entry?.preview.endsWith('…')).toBe(true);
    expect(entry?.preview.length).toBeLessThanOrEqual(81);
    expect(long.startsWith(entry?.preview.slice(0, -1) ?? '')).toBe(true);
  });
});
