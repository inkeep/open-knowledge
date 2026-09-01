import { afterEach, describe, expect, test } from 'vitest';
import { focusComposerInputOnCardPointer } from './focus-composer-on-card-pointer';

function harness() {
  const card = document.createElement('div');
  const padding = document.createElement('div');
  const control = document.createElement('button');
  card.append(padding, control);
  const portaledRow = document.createElement('div');
  portaledRow.setAttribute('role', 'menuitemradio');
  document.body.append(card, portaledRow);

  let prevented = 0;
  let focused = 0;
  let focusedEnd = 0;
  const inputRef: { current: { focus: () => void; focusEnd?: () => void } } = {
    current: { focus: () => (focused += 1) },
  };
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
    withFocusEnd: () => {
      inputRef.current.focusEnd = () => (focusedEnd += 1);
    },
    counts: () => ({ prevented, focused, focusedEnd }),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('the composer card pointer affordance', () => {
  test('a press on the card whitespace focuses the field', () => {
    const { padding, press, counts } = harness();
    press(padding);
    expect(counts()).toEqual({ prevented: 1, focused: 1, focusedEnd: 0 });
  });

  test('a handle offering focusEnd gets the caret-at-end path, not plain focus', () => {
    const { padding, press, withFocusEnd, counts } = harness();
    withFocusEnd();
    press(padding);
    expect(counts()).toEqual({ prevented: 1, focused: 0, focusedEnd: 1 });
  });

  test("a press on a control the card owns is the control's", () => {
    const { control, press, counts } = harness();
    press(control);
    expect(counts()).toEqual({ prevented: 0, focused: 0, focusedEnd: 0 });
  });

  test('a press inside a portaled floater is left alone', () => {
    const { portaledRow, press, counts } = harness();
    press(portaledRow);
    expect(counts()).toEqual({ prevented: 0, focused: 0, focusedEnd: 0 });
  });
});
