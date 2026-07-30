/**
 * Which transactions are allowed to skip a decoration rebuild.
 *
 * Every arrow key, click, and focus change dispatches a ProseMirror
 * transaction. Rebuilding the anchor decorations on all of them means building
 * a character-position index and re-resolving every open thread against it —
 * and for a thread whose quote no longer matches the document, re-resolving
 * costs three full-document scans. Measured on a 100k-character document with
 * 40 such threads, that was ~76 ms of work for pressing an arrow key.
 *
 * A regression here is invisible: the highlights stay correct, they just cost
 * far more than they should. So the classification itself is the assertion.
 */

import { describe, expect, test } from 'vitest';
import { anchorTransactionEffect } from './anchor-decorations';

const idle = { docChanged: false };
const edited = { docChanged: true };

describe('anchorTransactionEffect', () => {
  test('a selection-only transaction reuses the existing decorations', () => {
    // The case the whole change exists for: cursor moves, clicks, focus.
    expect(anchorTransactionEffect(idle, undefined)).toBe('reuse');
  });

  test('a document edit rebuilds', () => {
    expect(anchorTransactionEffect(edited, undefined)).toBe('rebuild');
  });

  test("the store's redraw ping rebuilds even though the document is unchanged", () => {
    // Thread state is not part of editor state, so a resolve, an edit, or a
    // change of active thread reaches the plugin ONLY as this meta. Treating it
    // as idle would freeze the highlights.
    expect(anchorTransactionEffect(idle, { refresh: true })).toBe('rebuild');
  });

  test('setting the composer draft is its own effect', () => {
    expect(anchorTransactionEffect(idle, { draft: { from: 3, to: 9 } })).toBe('draft');
  });

  test('clearing the composer draft still counts as a draft change', () => {
    // `{ draft: null }` is how cancel and post clear the pending highlight —
    // a null payload must not be mistaken for "no meta".
    expect(anchorTransactionEffect(idle, { draft: null })).toBe('draft');
  });

  test('a draft change during an edit is handled as a draft change', () => {
    expect(anchorTransactionEffect(edited, { draft: null })).toBe('draft');
  });

  test('an unrelated meta value does not reuse', () => {
    // Anything we do not recognise is treated as a reason to rebuild rather
    // than a reason to skip — wrong-but-cheap beats wrong-and-stale.
    expect(anchorTransactionEffect(idle, 'something-else')).toBe('rebuild');
  });
});
