// @vitest-environment jsdom

import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import {
  findBareHtmlImageTags,
  findRenderableBareHtmlImages,
  parseBareHtmlImage,
} from './bare-html-image-decoration';

const markdown = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

function parse(source: string) {
  return schema.nodeFromJSON(markdown.parse(source));
}

describe('bare HTML image decoration', () => {
  test('promotes a local HTML void image while leaving its PM bytes literal', () => {
    const source = '<img src="./missing.png" alt="team photo">\n';
    const doc = parse(source);
    const [image] = findRenderableBareHtmlImages(doc, 'notes/today');
    expect(image?.raw).toBe('<img src="./missing.png" alt="team photo">');
    expect(image?.props).toMatchObject({ src: '/notes/missing.png', alt: 'team photo' });
    expect(markdown.serialize(doc.toJSON())).toBe(source);
  });

  test('the scanner accepts a closing bracket inside a quoted attribute', () => {
    expect(findBareHtmlImageTags('<img src="./x.png" alt=">">')).toEqual([
      { index: 0, raw: '<img src="./x.png" alt=">">' },
    ]);
    expect(parseBareHtmlImage('<img src="./x.png" alt=">">', 'README')?.alt).toBe('>');
  });

  test.each([
    ['inline code', '`<img src="./x.png">`'],
    ['fenced code', '```html\n<img src="./x.png">\n```'],
    ['indented code', '    <img src="./x.png">'],
    ['escaped literal', '\\<img src="./x.png">'],
    ['entity-authored literal', '&lt;img src="./x.png"&gt;'],
  ])('does not promote %s', (_label, source) => {
    expect(findRenderableBareHtmlImages(parse(source), 'README')).toEqual([]);
  });

  test('leaves self-closing and external images to their existing render paths', () => {
    expect(parseBareHtmlImage('<img src="./x.png" />', 'README')).toBeNull();
    expect(parseBareHtmlImage('<img src="https://example.com/x.png">', 'README')).toBeNull();
  });

  test('keeps only valid HTML referrer policies', () => {
    expect(
      parseBareHtmlImage(
        '<img src="./x.png" referrerpolicy="strict-origin-when-cross-origin">',
        'README',
      )?.referrerpolicy,
    ).toBe('strict-origin-when-cross-origin');
    expect(
      parseBareHtmlImage('<img src="./x.png" referrerpolicy="not-a-policy">', 'README')
        ?.referrerpolicy,
    ).toBeUndefined();
  });
});
