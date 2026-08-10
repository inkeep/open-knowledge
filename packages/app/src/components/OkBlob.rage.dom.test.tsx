import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { OkBlob } from './OkBlob';
import { RAGE_WINDOW_MS } from './ok-blob-logic';

/**
 * `onRage` is the hook the empty-state blob hangs the game on. It has to fire
 * on a real rage-click and NOT on a programmatic celebration, or seeding a
 * project would open a game nobody asked for.
 */
describe('OkBlob onRage', () => {
  afterEach(() => cleanup());

  function blob(container: HTMLElement) {
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('blob svg missing');
    return svg;
  }

  test('fires once three rapid clicks land inside the rage window', () => {
    const onRage = vi.fn();
    const { container } = render(<OkBlob onRage={onRage} trackMouse={false} />);
    const svg = blob(container);

    fireEvent.click(svg);
    expect(onRage).not.toHaveBeenCalled();
    fireEvent.click(svg);
    expect(onRage).not.toHaveBeenCalled();
    fireEvent.click(svg);
    expect(onRage).toHaveBeenCalledTimes(1);
  });

  test('slow clicks never reach rage', () => {
    const onRage = vi.fn();
    const now = vi.spyOn(performance, 'now');
    const { container } = render(<OkBlob onRage={onRage} trackMouse={false} />);
    const svg = blob(container);

    // Each click lands well outside the rage window, so the level resets to 1.
    for (let i = 0; i < 5; i++) {
      now.mockReturnValue(i * (RAGE_WINDOW_MS + 50));
      fireEvent.click(svg);
    }
    expect(onRage).not.toHaveBeenCalled();
    now.mockRestore();
  });

  test('a sleeping mascot never rages', () => {
    const onRage = vi.fn();
    const { container } = render(<OkBlob onRage={onRage} variant="sleeping" trackMouse={false} />);
    const svg = blob(container);

    fireEvent.click(svg);
    fireEvent.click(svg);
    fireEvent.click(svg);
    expect(onRage).not.toHaveBeenCalled();
  });

  test('a programmatic celebration does NOT count as a user gesture', () => {
    const onRage = vi.fn();
    const { rerender } = render(<OkBlob onRage={onRage} celebrateSignal={0} trackMouse={false} />);
    // This is the post-seed burst. It reaches level 3 internally, but the user
    // did not ask for anything.
    rerender(<OkBlob onRage={onRage} celebrateSignal={1} trackMouse={false} />);
    expect(onRage).not.toHaveBeenCalled();
  });
});
