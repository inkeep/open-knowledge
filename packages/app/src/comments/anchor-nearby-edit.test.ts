import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { createAnchorResolver } from './anchor-search';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

const BODY = [
  '## Equipment',
  '',
  '- Grill pan or skillet',
  '- Skewers (optional)',
  '- Small bowl for the sauce',
  '',
  '## Steps',
  '',
  '1. Toss the chicken with the coconut milk, curry powder, turmeric, sugar, and fish sauce. Rest 15 minutes.',
  '2. Thread onto skewers if using.',
  '3. Sear in a hot grill pan until charred and cooked, about 10-12 minutes.',
  '4. Whisk the peanut sauce, loosening with water to a dip-able consistency, and serve alongside.',
].join('\n');

const QUOTE =
  'Toss the chicken with the coconut milk, curry powder, turmeric, sugar, and fish sauce. Rest 15 minutes.';

const at = BODY.indexOf(QUOTE);
const CONTEXT = {
  prefix: BODY.slice(Math.max(0, at - 32), at),
  suffix: BODY.slice(at + QUOTE.length, at + QUOTE.length + 32),
};

function resolve(markdown: string) {
  const doc = getSchema(sharedExtensions).nodeFromJSON(mdManager.parse(markdown));
  return createAnchorResolver(doc)(QUOTE, CONTEXT);
}

describe('a comment survives edits around it', () => {
  test('resolves against the document it was made on', () => {
    expect(resolve(BODY)).not.toBeNull();
  });

  test('survives the next list item being truncated', () => {
    expect(
      resolve(BODY.replace('2. Thread onto skewers if using.', '2. Thread onto ske')),
    ).not.toBeNull();
  });

  test('survives the next list item being replaced outright', () => {
    expect(
      resolve(BODY.replace('2. Thread onto skewers if using.', '2. Skip the skewers.')),
    ).not.toBeNull();
  });

  test('survives an edit to the heading above it', () => {
    expect(resolve(BODY.replace('## Steps', '## Method'))).not.toBeNull();
  });

  test('survives an edit on both sides at once', () => {
    const edited = BODY.replace('- Small bowl for the sauce', '- A bowl').replace(
      '2. Thread onto skewers if using.',
      '2. Thread onto ske',
    );
    expect(resolve(edited)).not.toBeNull();
  });

  test('still orphans when the passage itself is deleted', () => {
    expect(resolve(BODY.replace(`1. ${QUOTE}`, '1.'))).toBeNull();
  });
});
