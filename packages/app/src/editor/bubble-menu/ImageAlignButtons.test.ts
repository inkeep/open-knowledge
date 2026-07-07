/**
 * ImageAlignButtons — pure-helper tests for the selection-shape predicate.
 *
 * The interactive concerns (button click → setNodeMarkup → wrapper
 * `data-align` flips → CSS applies the corresponding `text-align`
 * rule) require a live editor + DOM and are exercised in Playwright
 * E2E. The unit-level structural tests here pin the contract that
 * `BubbleMenuBar` keys off:
 *
 *   - `isImageNodeSelected` returns true ONLY when the active selection
 *     is a `NodeSelection` over a `jsxComponent` with a recognized
 *     alignable componentName (`img`, `CommonMarkImage`, `Embed`,
 *     `video`) — anything else (paragraph text, non-alignable
 *     jsxComponents like `Callout`, no selection) returns false.
 *
 * The predicate is the load-bearing contract — `BubbleMenuBar`'s
 * `shouldShow` extension returns true on its strength so the menu pops
 * over a leaf atom that has no text content.
 *
 * Function name retained for back-compat with `BubbleMenuBar`'s import;
 * the predicate now matches every alignable descriptor (video parity
 * landed).
 */

import { describe, expect, test } from 'bun:test';
import type { Editor } from '@tiptap/react';
import { isImageNodeSelected } from './ImageAlignButtons';

/**
 * Stub the minimum surface of `Editor` that `isImageNodeSelected` reads:
 * `editor.state.selection.node` (only set on NodeSelection).
 */
function makeEditor(selection: object): Editor {
  return {
    state: { selection },
  } as unknown as Editor;
}

describe('isImageNodeSelected', () => {
  test('returns true for NodeSelection over img jsxComponent', () => {
    const editor = makeEditor({
      node: {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'img', props: { src: 'x.png', align: 'left' } },
      },
    });
    expect(isImageNodeSelected(editor)).toBe(true);
  });

  test('returns true even when align is not set (defaults to center)', () => {
    // Authors writing `<img />` without an `align` attr get center
    // alignment via `omitOnDefault`. The predicate fires regardless —
    // bubble-menu buttons must be reachable for any img selection so
    // the user can pick a non-center alignment.
    const editor = makeEditor({
      node: {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'img', props: { src: 'x.png' } },
      },
    });
    expect(isImageNodeSelected(editor)).toBe(true);
  });

  test('returns true for NodeSelection over CommonMarkImage jsxComponent', () => {
    // `![alt](src)` form gets the same alignment surface; the click
    // handler upgrades to `img` on first non-default alignment.
    const editor = makeEditor({
      node: {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'CommonMarkImage', props: { src: 'x.png', alt: '' } },
      },
    });
    expect(isImageNodeSelected(editor)).toBe(true);
  });

  test('returns true for NodeSelection over Embed jsxComponent', () => {
    const editor = makeEditor({
      node: {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'Embed', props: { src: 'https://example.com' } },
      },
    });
    expect(isImageNodeSelected(editor)).toBe(true);
  });

  test('returns true for NodeSelection over video jsxComponent (PRD-6822)', () => {
    // Video joined the alignable set — `htmlVideoProps`
    // now declares `align` with the same enum shape as `htmlImgProps`,
    // so the bubble-menu surface and chrome-bar buttons fire on
    // video selection too.
    const editor = makeEditor({
      node: {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'video', props: { src: 'x.mp4' } },
      },
    });
    expect(isImageNodeSelected(editor)).toBe(true);
  });

  test('returns false for NodeSelection over a non-alignable jsxComponent', () => {
    // Callout / Accordion / Tabs etc. are text-heavy block components
    // that don't get alignment — they fill the column. The predicate
    // stays false so the bubble menu doesn't surface alignment for
    // them.
    const editor = makeEditor({
      node: {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'Callout', props: { type: 'note' } },
      },
    });
    expect(isImageNodeSelected(editor)).toBe(false);
  });

  test('returns false for NodeSelection over a non-jsxComponent node', () => {
    // Other PM nodes that can be NodeSelected (paragraph wrapping a
    // tag atom, mathInline, etc.) are not the alignment surface.
    const editor = makeEditor({
      node: {
        type: { name: 'mathInline' },
        attrs: {},
      },
    });
    expect(isImageNodeSelected(editor)).toBe(false);
  });

  test('returns false when selection has no `node` field (TextSelection)', () => {
    // TextSelection / AllSelection don't carry `node`. The predicate
    // must short-circuit so the bubble-menu doesn't swap into image
    // mode for plain text selections that happen to overlap an image.
    const editor = makeEditor({ from: 5, to: 10 });
    expect(isImageNodeSelected(editor)).toBe(false);
  });

  test('returns false for empty selection (no `node`, no shape)', () => {
    const editor = makeEditor({});
    expect(isImageNodeSelected(editor)).toBe(false);
  });
});
