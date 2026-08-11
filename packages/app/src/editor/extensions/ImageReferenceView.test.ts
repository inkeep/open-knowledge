import { getSchema } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { resolveImageReferenceHref } from './ImageReferenceView';
import { sharedExtensions } from './shared';

const schema = getSchema(sharedExtensions);

function makeDoc(...definitions: Array<{ label: string; href: string }>) {
  return schema.node('doc', undefined, [
    schema.node('paragraph'),
    ...definitions.map(({ label, href }) => schema.node('linkRefDef', { label, href })),
  ]);
}

describe('resolveImageReferenceHref', () => {
  test('matches the normalized image identifier to its definition label', () => {
    const doc = makeDoc({ label: '  Product   Shot  ', href: './assets/product.png' });
    expect(resolveImageReferenceHref(doc, 'product shot')).toBe('./assets/product.png');
  });

  test('uses the first matching definition, like CommonMark reference resolution', () => {
    const doc = makeDoc(
      { label: 'photo', href: '/assets/first.png' },
      { label: 'PHOTO', href: '/assets/second.png' },
    );
    expect(resolveImageReferenceHref(doc, 'photo')).toBe('/assets/first.png');
  });

  test('matches labels with CommonMark Unicode case folding', () => {
    const doc = makeDoc({ label: 'SS', href: '/assets/unicode.png' });
    expect(resolveImageReferenceHref(doc, 'ẞ')).toBe('/assets/unicode.png');
  });

  test('returns undefined when no definition resolves the image reference', () => {
    expect(resolveImageReferenceHref(makeDoc(), 'missing')).toBeUndefined();
  });
});
