/**
 * The composer card's "press the whitespace, focus the field" handler.
 *
 * The three branches it has to keep apart, since two of them look identical
 * from inside the handler: a press on the card's own padding (act), a press on
 * a control the card owns (leave it alone), and a press that only *bubbles*
 * through the card from a portaled floater opened by one of those controls
 * (leave it alone). React portals bubble synthetic events along the React
 * tree, so the third arrives here with the card as `currentTarget` even though
 * the floater renders under `document.body`.
 */

import { afterEach, describe, expect, test } from 'vitest';
import { focusComposerInputOnCardPointer } from './focus-composer-on-card-pointer';

function harness() {
  const card = document.createElement('div');
  const padding = document.createElement('div');
  const control = document.createElement('button');
  card.append(padding, control);
  // A Radix menu row: rendered under `document.body`, outside the card, but
  // reached by the card's React `onMouseDown` all the same.
  const portaledRow = document.createElement('div');
  portaledRow.setAttribute('role', 'menuitemradio');
  document.body.append(card, portaledRow);

  let prevented = 0;
  let focused = 0;
  const inputRef = { current: { focus: () => (focused += 1) } };
  const press = (target: HTMLElement) => {
    focusComposerInputOnCardPointer(
      { target, currentTarget: card, preventDefault: () => (prevented += 1) },
      inputRef,
    );
  };

  return {
    padding,
    control,
    portaledRow,
    press,
    counts: () => ({ prevented, focused }),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('the composer card pointer affordance', () => {
  test('a press on the card whitespace focuses the field', () => {
    // Without `preventDefault` focus visibly bounces to the card first and a
    // text-selection drag starts on the padding.
    const { padding, press, counts } = harness();
    press(padding);
    expect(counts()).toEqual({ prevented: 1, focused: 1 });
  });

  test("a press on a control the card owns is the control's", () => {
    const { control, press, counts } = harness();
    press(control);
    expect(counts()).toEqual({ prevented: 0, focused: 0 });
  });

  test('a press inside a portaled floater is left alone', () => {
    // Claiming it stole focus out of the open menu, which dismissed the
    // submenu layer before the row's `click` landed — so the pick was lost.
    const { portaledRow, press, counts } = harness();
    press(portaledRow);
    expect(counts()).toEqual({ prevented: 0, focused: 0 });
  });
});
