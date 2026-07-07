import { describe, expect, test } from 'bun:test';
import { computeBodyStats, computeSelectionStats, EMPTY_STATS } from './document-stats';

describe('computeBodyStats', () => {
  test('empty string returns zeros', () => {
    expect(computeBodyStats('')).toEqual({ words: 0, chars: 0, tokens: 0 });
  });

  test('plain text without frontmatter', () => {
    expect(computeBodyStats('hello world foo')).toEqual({ words: 3, chars: 15, tokens: 4 });
  });

  test('frontmatter excluded from words and chars', () => {
    const md = '---\ntitle: Test\n---\nhello world';
    expect(computeBodyStats(md)).toEqual({ words: 2, chars: 11, tokens: 3 });
  });

  test('whitespace-only body returns zero', () => {
    expect(computeBodyStats('   \n\n  \t  ')).toEqual({ words: 0, chars: 0, tokens: 0 });
  });

  test('single word', () => {
    expect(computeBodyStats('hello')).toEqual({ words: 1, chars: 5, tokens: 2 });
  });

  test('multiline text counts words across lines', () => {
    expect(computeBodyStats('one\ntwo\nthree').words).toBe(3);
  });

  test('leading and trailing whitespace does not produce phantom words', () => {
    expect(computeBodyStats('  hello  world  ').words).toBe(2);
  });

  test('markdown syntax tokens (#, >, ---) are not counted as words', () => {
    expect(computeBodyStats('# test').words).toBe(1);
    expect(computeBodyStats('> a quote').words).toBe(2);
    expect(computeBodyStats('--- separator ---').words).toBe(1);
  });

  test('frontmatter-only document has zero body stats', () => {
    expect(computeBodyStats('---\ntitle: Test\ntags: [a, b]\n---\n')).toEqual({
      words: 0,
      chars: 0,
      tokens: 0,
    });
  });

  test('CJK without whitespace counts word-like segments via Intl.Segmenter', () => {
    // 这是一个测试文档 — each character is a word-like segment in Chinese.
    const stats = computeBodyStats('这是一个测试文档');
    // Segmenter behavior is locale-dependent, but each CJK ideograph is
    // word-like; we only assert "more than one" to avoid over-specifying.
    expect(stats.words).toBeGreaterThan(1);
  });

  test('mixed CJK + ASCII still segments correctly', () => {
    const stats = computeBodyStats('hello 世界 world');
    expect(stats.words).toBeGreaterThanOrEqual(3);
  });

  test('empty MDX callout contributes zero to counts', () => {
    const md = 'hello\n\nworld\n\n<Callout type="info">\n\n</Callout>\n';
    const stats = computeBodyStats(md);
    expect(stats.words).toBe(2);
    expect(stats.chars).toBe(11);
  });

  test('MDX callout body counts but tag/attr names do not', () => {
    const md = '<Callout type="info">\n\nimportant note\n\n</Callout>\n';
    const stats = computeBodyStats(md);
    expect(stats.words).toBe(2);
    expect(stats.chars).toBe('important note'.length);
  });

  test('link visible text counts, URL does not', () => {
    const stats = computeBodyStats('see [the docs](https://example.com/path/to/page)');
    expect(stats.words).toBe(3);
    expect(stats.chars).toBe('see the docs'.length);
  });

  test('image alt text does not count', () => {
    const stats = computeBodyStats('![a long alt description](https://example.com/img.png)');
    expect(stats).toEqual({ words: 0, chars: 0, tokens: 0 });
  });

  test('wikilink alias is preferred over target', () => {
    const stats = computeBodyStats('see [[Some Page|the page]]');
    expect(stats.words).toBe(3);
    expect(stats.chars).toBe('see the page'.length);
  });

  test('wikilink without alias falls back to target name', () => {
    const stats = computeBodyStats('see [[Some Page]]');
    expect(stats.words).toBe(3);
    expect(stats.chars).toBe('see Some Page'.length);
  });

  test('inline code content counts', () => {
    const stats = computeBodyStats('use `useEffect` here');
    expect(stats.words).toBe(3);
  });

  test('fenced code block content counts toward stats', () => {
    const md = ['before', '', '```js', 'const x = 1', '```', '', 'after'].join('\n');
    const stats = computeBodyStats(md);
    expect(stats.words).toBe(5);
    expect(stats.chars).toBe('before\nconst x = 1\nafter'.length);
  });

  test('emphasis and strong markers do not inflate chars', () => {
    const stats = computeBodyStats('**bold** and *italic*');
    expect(stats.words).toBe(3);
    expect(stats.chars).toBe('bold and italic'.length);
  });

  test('arbitrary MDX components contribute zero when empty', () => {
    // Generalizes beyond Callout — Note, Tabs, Card, custom components etc.
    // all share the mdxJsxFlowElement shape and must drop tag/attr names.
    const md = [
      'hi',
      '',
      '<Note>\n\n</Note>',
      '',
      '<Tabs defaultValue="a">\n\n<Tab value="a">\n\n</Tab>\n\n</Tabs>',
      '',
      '<CustomThingamajig foo="bar" baz={true}>\n\n</CustomThingamajig>',
    ].join('\n');
    const stats = computeBodyStats(md);
    expect(stats.words).toBe(1);
    expect(stats.chars).toBe(2);
  });

  test('inline MDX component body counts; tag/attr do not', () => {
    const md = 'press <Kbd shortcut="cmd+s">save</Kbd> now';
    const stats = computeBodyStats(md);
    expect(stats.words).toBe(3);
    expect(stats.chars).toBe('press save now'.length);
  });

  test('MDX components with bodies count their inner content only', () => {
    const md = [
      '<Card title="Ignored attr">',
      '',
      'card body text',
      '',
      '</Card>',
      '',
      '<Note>',
      '',
      'note body',
      '',
      '</Note>',
    ].join('\n');
    const stats = computeBodyStats(md);
    expect(stats.words).toBe(5);
    expect(stats.chars).toBe('card body text\nnote body'.length);
  });
});

describe('computeSelectionStats', () => {
  test('empty / whitespace selection returns EMPTY_STATS', () => {
    expect(computeSelectionStats('', { isMarkdown: false })).toEqual(EMPTY_STATS);
    expect(computeSelectionStats('   \n ', { isMarkdown: false })).toEqual(EMPTY_STATS);
    expect(computeSelectionStats('', { isMarkdown: true })).toEqual(EMPTY_STATS);
  });

  test('WYSIWYG selection (isMarkdown:false) counts visible text directly', () => {
    expect(computeSelectionStats('hello world', { isMarkdown: false })).toEqual({
      words: 2,
      chars: 11,
      tokens: 3,
    });
  });

  test('WYSIWYG selection does not strip syntax — PM text is already visible', () => {
    // ProseMirror never emits markdown syntax; this pins that the false branch
    // counts the bytes as-seen ("##" is not word-like; the chars still count).
    expect(computeSelectionStats('## Hello', { isMarkdown: false })).toEqual({
      words: 1,
      chars: 8,
      tokens: 2,
    });
  });

  test('source selection (isMarkdown:true) strips syntax like the doc counter', () => {
    expect(computeSelectionStats('## Hello', { isMarkdown: true })).toEqual({
      words: 1,
      chars: 5,
      tokens: 2,
    });
    expect(computeSelectionStats('**bold** and *italic*', { isMarkdown: true })).toEqual({
      words: 3,
      chars: 15,
      tokens: 4,
    });
  });

  test('same passage counts identically in both modes (visible-text parity)', () => {
    // Selecting the heading text "Hello" in WYSIWYG vs "## Hello" in source.
    expect(computeSelectionStats('## Hello', { isMarkdown: true })).toEqual(
      computeSelectionStats('Hello', { isMarkdown: false }),
    );
  });

  test('CJK selection routes to the segmenter', () => {
    expect(computeSelectionStats('这是一个测试文档', { isMarkdown: false }).words).toBeGreaterThan(
      1,
    );
  });
});
