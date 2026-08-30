/**
 * globals.css `.ok-pointer-marker` visual-contract guard.
 *
 * The ring the bug-report gate draws at the last known pointer position is the
 * only explanation a reader of a hover-state report gets for why a row in the
 * screenshot is highlighted — `capturePage()` omits the cursor. Its entire
 * geometry lives in this one CSS rule, and the code that injects it depends on
 * three of the declarations directly: `markPointerPosition` sets only inline
 * `left` / `top`, which are the pointer's viewport coordinates and are wrong
 * unless `position: fixed` and the centring `transform` are both present, and
 * the ring exists specifically to annotate reports filed ABOUT an overlay, so
 * it has to out-stack every layer in the app.
 *
 * Source-level regex guards by necessity, in the shape the sibling
 * `globals.*.test.ts` files established: jsdom applies no stylesheet, so a DOM
 * test can only see that an element with the class exists carrying the right
 * inline coordinates — true with or without this rule. The one tier that sees
 * real pixels (`packages/desktop/tests/smoke/report-bug.e2e.ts`) parks the
 * pointer identically for both of its captures on purpose, which cancels the
 * marker out of its diff by construction. So nothing anywhere reds if a
 * declaration here is dropped, and the failure it would ship is a ring at the
 * document origin, off by half its size, or hidden under the very overlay the
 * report is about.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const RAW_CSS = readFileSync(join(__dirname, 'globals.css'), 'utf8');
/** Comments stripped so the rule's own prose cannot satisfy a match. */
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The `.ok-pointer-marker` declaration body, bounded to that block. Bounding
 * matters: a whole-file `toMatch` would pass on any rule in 6000 lines that
 * happens to carry the declaration, which is the shape that asserts nothing.
 */
function markerDeclarations(): string {
  const block = CSS.match(/(?:^|[}\s])\.ok-pointer-marker\s*\{([^{}]*)\}/);
  return block?.[1] ?? '';
}

describe('globals.css — .ok-pointer-marker', () => {
  test('the rule exists (guard is not vacuous)', () => {
    expect(markerDeclarations().trim().length).toBeGreaterThan(0);
  });

  test('is viewport-positioned, so the injected inline left/top are pointer coordinates', () => {
    // `markPointerPosition` writes `event.clientX/clientY` straight into
    // `style.left/top`. Anything but `fixed` re-anchors those to the nearest
    // positioned ancestor or the document, putting the ring somewhere the
    // pointer never was — worse than the null the tracker returns when it has
    // no position at all.
    expect(markerDeclarations()).toMatch(/position\s*:\s*fixed/);
  });

  test('centres itself on those coordinates', () => {
    // Without this the ring hangs down-right of the pointer by half its size,
    // which on a 22px ring is enough to annotate the neighbouring row.
    expect(markerDeclarations()).toMatch(/transform\s*:\s*translate\(\s*-50%\s*,\s*-50%\s*\)/);
  });

  test('out-stacks every layer in the app', () => {
    // The motivating report is one filed ABOUT an open overlay, so the ring
    // has to sit on top of a Radix layer that sets its own z-index.
    const zIndex = markerDeclarations().match(/z-index\s*:\s*(\d+)/);
    expect(zIndex, 'z-index declaration must be present').not.toBeNull();
    expect(Number(zIndex?.[1])).toBe(2147483647);
  });

  test('keeps both of its visual channels under forced colors', () => {
    // Forced-colors mode forces `border-color` to a system colour and strips
    // `box-shadow`, which would collapse the ring to the same colour as every
    // border underneath it. The colours here are meaning rather than theming,
    // so the element opts out.
    expect(markerDeclarations()).toMatch(/forced-color-adjust\s*:\s*none/);
  });

  test('does not intercept input while it is on screen', () => {
    // It is drawn over a live app for the length of the capture round trip.
    expect(markerDeclarations()).toMatch(/pointer-events\s*:\s*none/);
  });

  test('draws a hollow ring rather than a filled dot', () => {
    // The pixel being pointed at has to stay visible in the screenshot.
    expect(markerDeclarations()).toMatch(/border\s*:\s*[^;]*solid/);
    expect(markerDeclarations()).toMatch(/border-radius\s*:\s*50%/);
    expect(markerDeclarations()).toMatch(/background\s*:\s*transparent/);
  });
});
