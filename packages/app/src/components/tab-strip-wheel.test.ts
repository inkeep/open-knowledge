import type { WheelEvent } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { scrollTabStripOnWheel } from './tab-strip-wheel';

/** Minimal stand-in for the React WheelEvent fields the handler reads. */
function wheelEvent(opts: {
  deltaX: number;
  deltaY: number;
  scrollWidth: number;
  clientWidth: number;
  scrollLeft?: number;
}) {
  const preventDefault = vi.fn(() => {});
  const currentTarget = {
    scrollWidth: opts.scrollWidth,
    clientWidth: opts.clientWidth,
    scrollLeft: opts.scrollLeft ?? 0,
  };
  const event = {
    deltaX: opts.deltaX,
    deltaY: opts.deltaY,
    currentTarget,
    preventDefault,
  } as unknown as WheelEvent<HTMLElement>;
  return { event, currentTarget, preventDefault };
}

describe('scrollTabStripOnWheel', () => {
  test('ignores a horizontal-dominant gesture (native scroll already handles it)', () => {
    const { event, currentTarget, preventDefault } = wheelEvent({
      deltaX: 30,
      deltaY: 5,
      scrollWidth: 400,
      clientWidth: 200,
    });
    scrollTabStripOnWheel(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(currentTarget.scrollLeft).toBe(0);
  });

  test('ignores a vertical gesture when the strip does not overflow', () => {
    const { event, currentTarget, preventDefault } = wheelEvent({
      deltaX: 0,
      deltaY: 40,
      scrollWidth: 200,
      clientWidth: 200,
    });
    scrollTabStripOnWheel(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(currentTarget.scrollLeft).toBe(0);
  });

  test('maps a vertical gesture to horizontal scroll when the strip overflows', () => {
    const { event, currentTarget, preventDefault } = wheelEvent({
      deltaX: 0,
      deltaY: 40,
      scrollWidth: 400,
      clientWidth: 200,
      scrollLeft: 10,
    });
    scrollTabStripOnWheel(event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(currentTarget.scrollLeft).toBe(50);
  });
});
