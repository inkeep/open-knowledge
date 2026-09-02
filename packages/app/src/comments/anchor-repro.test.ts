import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { createAnchorResolver } from './anchor-search';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
void getSchema(sharedExtensions);

const BODY = [
  '## Decisions',
  '',
  '1. **⌘L arbitration — decided.** ⌘L stages into the agents panel specifically. A name its target.',
  '2. **Rail bare-letters — deferred** to a separate story.',
  '',
  '**Decided:** ⌘L stages into the **agents panel** specifically. The principle is that a chord should name its target.',
  '',
  'Worth confirming before anyone builds.e agents panel',
].join('\n');

const QUOTE = 'e agents pan';

function bodyContext(body: string, at: number): { prefix: string; suffix: string } {
  return {
    prefix: body.slice(Math.max(0, at - 32), at),
    suffix: body.slice(at + QUOTE.length, at + QUOTE.length + 32),
  };
}

function docFor(markdown: string) {
  return getSchema(sharedExtensions).nodeFromJSON(mdManager.parse(markdown));
}

describe('the check-in repro', () => {
  test('the commented occurrence resolves while it exists', () => {
    const at = BODY.indexOf(QUOTE);
    const context = bodyContext(BODY, at);
    const range = createAnchorResolver(docFor(BODY))(QUOTE, context);
    expect(range).not.toBeNull();
  });

  test('deleting the selection orphans instead of sliding to the bold twin', () => {
    const at = BODY.indexOf(QUOTE);
    const context = bodyContext(BODY, at);
    const afterDelete = BODY.slice(0, at) + BODY.slice(at + QUOTE.length);
    const range = createAnchorResolver(docFor(afterDelete))(QUOTE, context);
    expect(range).toBeNull();
  });
});
