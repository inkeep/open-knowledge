/**
 * Field repro: editing a NEIGHBOUR of a commented passage made the highlight
 * vanish, though the commented words were untouched.
 *
 * A recipe's step 1 carried a comment; deleting most of step 2 dropped the
 * highlight off step 1. The passage itself still matched literally and was the
 * document's only hit, so nothing about the quote explained it — the loss was
 * in the context gate. A stored anchor's `prefix`/`suffix` are sliced out of
 * the markdown body, so a 32-character window around a list item picks up its
 * `1. ` and its neighbour's `2. `; scoring them against rendered text without
 * treating those as syntax put a marker at the seam and took the common run to
 * zero. Every candidate scored 0, the evidence floor was never met, and
 * resolution fell through to bracket recovery, which needs the surroundings
 * intact — so any edit inside the context window orphaned the thread.
 *
 * The invariant these hold: a comment survives edits to text NEAR it, and only
 * an edit to the passage (or its disappearance) may take the highlight away.
 */

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

/** What `createAnchor` stores: 32 chars of the markdown BODY either side. */
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
    // The reported gesture: half of step 2 deleted. Step 2 sits inside step 1's
    // stored suffix, so this is what the context gate has to tolerate.
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
    // The gate exists to stop a deleted passage re-anchoring elsewhere; making
    // it reachable must not make it toothless.
    expect(resolve(BODY.replace(`1. ${QUOTE}`, '1.'))).toBeNull();
  });
});
