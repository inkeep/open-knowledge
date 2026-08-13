/**
 * Field repro: the check-in doc where deleting "e agents pan" slid the
 * highlight onto the "Decided:" paragraph's copy.
 *
 * Reconstructed from the report, with the properties that make it hard kept
 * intact: the surviving twin renders the same words but carries `**bold**`
 * markup in the body (so the quote is not literally present there in markdown,
 * only in rendered text), and a third stray occurrence sits at the end of the
 * document with unrelated context. Real markdown pipeline, real index — not a
 * hand-built fixture.
 */

import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { createAnchorResolver } from './anchor-search';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
// The schema import keeps parity with anchor-search.test.ts's setup; parsing
// alone is what this suite needs.
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

/** Server-style context: 32 chars of the markdown body either side. */
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
    // Exactly the reported gesture: the selected text removed where it stood.
    const afterDelete = BODY.slice(0, at) + BODY.slice(at + QUOTE.length);
    const range = createAnchorResolver(docFor(afterDelete))(QUOTE, context);
    expect(range).toBeNull();
  });
});
