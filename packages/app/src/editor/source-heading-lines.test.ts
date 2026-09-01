import { Text } from '@codemirror/state';
import { describe, expect, test } from 'vitest';
import { type SourceHeadingLine, sourceHeadingLines } from './source-heading-lines';

function docOf(lines: string[]): Text {
  return Text.of(lines);
}

function slugs(entries: readonly SourceHeadingLine[]): string[] {
  return entries.map((entry) => entry.slug);
}

function froms(entries: readonly SourceHeadingLine[]): number[] {
  return entries.map((entry) => entry.from);
}

function lineStarts(doc: Text, lineNumbers: number[]): number[] {
  return lineNumbers.map((n) => doc.line(n).from);
}

describe('sourceHeadingLines', () => {
  test('returns one entry per heading line in document order', () => {
    const doc = docOf([
      '# Title',
      '',
      'Intro prose.',
      '',
      '## First',
      '',
      '### Nested',
      '',
      '## Second',
    ]);

    const entries = sourceHeadingLines(doc);

    expect(slugs(entries)).toEqual(['title', 'first', 'nested', 'second']);
    expect(froms(entries)).toEqual(lineStarts(doc, [1, 5, 7, 9]));
  });

  test('points `from` at the line start, before the hashes', () => {
    const doc = docOf(['Prose.', '', '## Heading']);

    const [entry] = sourceHeadingLines(doc);

    expect(entry.from).toBe(doc.line(3).from);
    expect(doc.sliceString(entry.from, entry.from + 2)).toBe('##');
  });

  test('returns nothing for a document with no headings', () => {
    expect(sourceHeadingLines(docOf(['Just prose.', '', 'More prose.']))).toEqual([]);
  });

  test('skips the frontmatter region so a YAML comment is not heading zero', () => {
    const doc = docOf([
      '---',
      'title: Fence hazard',
      '# yaml comment, not a heading',
      '---',
      '',
      '# Real Heading',
    ]);

    const entries = sourceHeadingLines(doc);

    expect(slugs(entries)).toEqual(['real-heading']);
    expect(froms(entries)).toEqual(lineStarts(doc, [6]));
  });

  test('skips frontmatter whose opening fence carries a trailing space', () => {
    const doc = docOf([
      '--- ',
      'title: Fence hazard',
      '# yaml comment, not a heading',
      '---',
      '',
      '# Real Heading',
    ]);

    expect(slugs(sourceHeadingLines(doc))).toEqual(['real-heading']);
  });

  test('skips frontmatter whose closing fence carries a trailing tab', () => {
    const doc = docOf([
      '---',
      'title: Fence hazard',
      '# yaml comment, not a heading',
      '---\t',
      '',
      '# Real Heading',
    ]);

    expect(slugs(sourceHeadingLines(doc))).toEqual(['real-heading']);
  });

  test('skips frontmatter whose fences carry Windows line endings', () => {
    const doc = docOf(['---\r', 'title: Windows\r', '# yaml comment\r', '---\r', '\r', '# Real\r']);

    expect(slugs(sourceHeadingLines(doc))).toEqual(['real']);
  });

  test('treats an unclosed leading fence as body, not frontmatter', () => {
    const doc = docOf(['---', 'title: Never closed', '# Looks like yaml', '']);

    expect(slugs(sourceHeadingLines(doc))).toEqual(['looks-like-yaml']);
  });

  test('does not start a frontmatter skip at a mid-document thematic break', () => {
    const doc = docOf(['# Real', '', '---', '', '## After']);

    const entries = sourceHeadingLines(doc);

    expect(slugs(entries)).toEqual(['real', 'after']);
    expect(froms(entries)).toEqual(lineStarts(doc, [1, 5]));
  });

  test('skips hash lines inside a backtick code fence', () => {
    const doc = docOf([
      '# Top',
      '',
      '```yaml',
      '# electron-builder.yml',
      'appId: com.example',
      '```',
      '',
      '## After',
    ]);

    const entries = sourceHeadingLines(doc);

    expect(slugs(entries)).toEqual(['top', 'after']);
    expect(froms(entries)).toEqual(lineStarts(doc, [1, 8]));
  });

  test('skips hash lines inside a tilde code fence', () => {
    const doc = docOf(['# Top', '~~~bash', '# not a heading', '~~~', '## After']);

    expect(slugs(sourceHeadingLines(doc))).toEqual(['top', 'after']);
  });

  test('an unclosed code fence swallows the rest of the document', () => {
    const doc = docOf(['# Real', '```js', '# inside', '## still inside']);

    expect(slugs(sourceHeadingLines(doc))).toEqual(['real']);
  });

  test('disambiguates duplicate slugs across the whole document', () => {
    const doc = docOf(['# Intro', '', '## Intro', '', '## 東京', '', '## 東京']);

    expect(slugs(sourceHeadingLines(doc))).toEqual(['intro', 'intro-1', '東京', '東京-1']);
  });

  test('does not count hashes with no heading text', () => {
    const doc = docOf(['# Real', '', '### ', '', '## After']);

    const entries = sourceHeadingLines(doc);

    expect(slugs(entries)).toEqual(['real', 'after']);
    expect(froms(entries)).toEqual(lineStarts(doc, [1, 5]));
  });

  test('does not count a heading whose text slugs to nothing', () => {
    const doc = docOf(['# Real', '', '## ---', '', '## After']);

    const entries = sourceHeadingLines(doc);

    expect(slugs(entries)).toEqual(['real', 'after']);
    expect(froms(entries)).toEqual(lineStarts(doc, [1, 5]));
  });

  test('reuses the previous result for the same document instance', () => {
    const doc = docOf(['# One', '', '## Two']);

    const first = sourceHeadingLines(doc);

    expect(sourceHeadingLines(doc)).toBe(first);
  });

  test('rescans after the document changes', () => {
    const doc = docOf(['# One', '', '## Two']);
    const first = sourceHeadingLines(doc);

    const grown = doc.append(docOf(['', '## Three']));
    const second = sourceHeadingLines(grown);

    expect(second).not.toBe(first);
    expect(slugs(second)).toEqual(['one', 'two', 'three']);
    expect(froms(second)).toEqual(lineStarts(grown, [1, 3, 4]));
  });

  test('answers correctly for a document that has fallen out of the cache', () => {
    const doc = docOf(['# One', '', '## Two']);
    sourceHeadingLines(doc);
    sourceHeadingLines(doc.append(docOf(['', '## Three'])));

    expect(slugs(sourceHeadingLines(doc))).toEqual(['one', 'two']);
  });
});
