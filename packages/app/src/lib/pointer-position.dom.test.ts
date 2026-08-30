/**
 * Substrate: jsdom via `pnpm run test:dom`. No component renders here — the
 * tracker is plain window listeners over module state.
 */

import { afterEach, describe, expect, test } from 'vitest';
import { getLastPointerPosition, installPointerPositionTracker } from './pointer-position';

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

function movePointerTo(x: number, y: number): void {
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
}

describe('last-known pointer position', () => {
  test('reports nothing until the pointer moves, then where it moved to', () => {
    uninstall = installPointerPositionTracker();

    expect(getLastPointerPosition()).toBeNull();

    movePointerTo(120, 48);
    expect(getLastPointerPosition()).toEqual({ x: 120, y: 48 });

    movePointerTo(640, 300);
    expect(getLastPointerPosition()).toEqual({ x: 640, y: 300 });
  });

  test('forgets the position once the pointer leaves the window', () => {
    uninstall = installPointerPositionTracker();
    movePointerTo(120, 48);

    // Crossing between two elements inside the window is not leaving it.
    window.dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
    );
    expect(getLastPointerPosition()).toEqual({ x: 120, y: 48 });

    window.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
    expect(getLastPointerPosition()).toBeNull();
  });

  test('a second install does not let the first disposer blind the second', () => {
    // Two listener pairs on one module-global position: disposing the first
    // would forget the position while the second pair is still recording into
    // it, so the tracker reads as installed and answers null forever.
    const stop = installPointerPositionTracker();
    const stopAgain = installPointerPositionTracker();
    movePointerTo(200, 90);

    expect(stopAgain).toBe(stop);
    expect(getLastPointerPosition()).toEqual({ x: 200, y: 90 });

    stop();
    expect(getLastPointerPosition()).toBeNull();

    // And the module is installable again afterwards, not latched shut.
    const restart = installPointerPositionTracker();
    movePointerTo(15, 25);
    expect(getLastPointerPosition()).toEqual({ x: 15, y: 25 });
    restart();
  });

  test('reports nothing once uninstalled, and stops recording', () => {
    const stop = installPointerPositionTracker();
    movePointerTo(120, 48);

    stop();
    expect(getLastPointerPosition()).toBeNull();

    movePointerTo(640, 300);
    expect(getLastPointerPosition()).toBeNull();
  });
});
