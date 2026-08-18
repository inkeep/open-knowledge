import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { OkBlob } from './OkBlob';
import { IDLE_RESET_MS, RAGE_WINDOW_MS } from './ok-blob-logic';

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

  test('keeps counting rage clicks while the burst plays', () => {
    // The reveal gate upstream counts these, so a click that lands during the
    // firework has to register — otherwise the climb stalls at the moment the
    // user is clicking hardest.
    const onRage = vi.fn();
    const { container } = render(<OkBlob onRage={onRage} trackMouse={false} />);
    const svg = blob(container);

    for (let i = 0; i < 3; i++) fireEvent.click(svg);
    expect(onRage).toHaveBeenCalledTimes(1);

    fireEvent.click(svg);
    fireEvent.click(svg);
    expect(onRage).toHaveBeenCalledTimes(3);
  });

  test('a click during a burst does not restart the burst', () => {
    const { container } = render(<OkBlob trackMouse={false} />);
    const svg = blob(container);

    for (let i = 0; i < 3; i++) fireEvent.click(svg);
    const burst = container.querySelector('[data-slot="ok-blob-burst"]');
    expect(burst).toBeTruthy();

    fireEvent.click(svg);
    // Same node kept across the click, so the CSS animation runs to completion
    // instead of snapping back to frame zero on every press.
    expect(container.querySelector('[data-slot="ok-blob-burst"]')).toBe(burst);
  });

  test('a click past the burst lifetime earns a fresh burst', () => {
    // Sustained rage must not mean "one firework, then nothing": the burst is
    // spent after IDLE_RESET_MS, and a user still clicking has earned another.
    const now = vi.spyOn(performance, 'now');
    const { container } = render(<OkBlob trackMouse={false} />);
    const svg = blob(container);

    // Non-zero base: `lastClickTimeRef` uses 0 as its no-previous-click
    // sentinel, so a clock starting at 0 reads every gap as infinite and the
    // level never climbs.
    const T0 = 1_000;
    now.mockReturnValue(T0);
    fireEvent.click(svg);
    now.mockReturnValue(T0 + 100);
    fireEvent.click(svg);
    now.mockReturnValue(T0 + 200);
    fireEvent.click(svg);
    const first = container.querySelector('[data-slot="ok-blob-burst"]');
    expect(first).toBeTruthy();

    // Still in the air — left alone.
    now.mockReturnValue(T0 + 400);
    fireEvent.click(svg);
    expect(container.querySelector('[data-slot="ok-blob-burst"]')).toBe(first);

    // Keep clicking inside the rage window so the level never drops, until the
    // clock is past the burst's life. Spacing matters: a single jump to the far
    // side of IDLE_RESET_MS would exceed RAGE_WINDOW_MS, reset the level to 1
    // and clear the particles, so the burst would vanish rather than be
    // replaced and this would pass without exercising re-detonation at all.
    const burstStartedAt = T0 + 200;
    for (let t = T0 + 900; t < burstStartedAt + IDLE_RESET_MS; t += 500) {
      now.mockReturnValue(t);
      fireEvent.click(svg);
      expect(container.querySelector('[data-slot="ok-blob-burst"]')).toBe(first);
    }

    // Past the burst's life, still holding rage: the sustained clicker the old
    // rule left with a dead mascot now gets a fresh burst.
    now.mockReturnValue(burstStartedAt + IDLE_RESET_MS + 1);
    fireEvent.click(svg);
    const second = container.querySelector('[data-slot="ok-blob-burst"]');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    now.mockRestore();
  });

  test('a celebration landing on a live streak keeps its burst', () => {
    // The celebrate effect re-stamps the burst clock. That only decides
    // anything in one window: rage is being held, the click-driven burst is
    // about to age out, and the celebration renews it — so the next click
    // treats the celebration as in-flight instead of detonating over it.
    // The effect does not touch `lastClickTimeRef`, so the click cadence has
    // to carry the level on its own.
    const now = vi.spyOn(performance, 'now');
    const T0 = 1_000;
    const { container, rerender } = render(<OkBlob celebrateSignal={0} trackMouse={false} />);
    const svg = blob(container);

    now.mockReturnValue(T0);
    fireEvent.click(svg);
    now.mockReturnValue(T0 + 100);
    fireEvent.click(svg);
    now.mockReturnValue(T0 + 200);
    fireEvent.click(svg); // rage: burst stamped at T0 + 200
    const clickBurst = container.querySelector('[data-slot="ok-blob-burst"]');
    expect(clickBurst).toBeTruthy();

    // Hold rage until that first burst is nearly spent, without regenerating it.
    let t = T0 + 700;
    for (; t < T0 + 200 + IDLE_RESET_MS; t += 500) {
      now.mockReturnValue(t);
      fireEvent.click(svg);
    }
    const lastClickAt = t - 500;

    // Celebration renews the clock just before the click-driven burst expires.
    const celebratedAt = lastClickAt + 50;
    now.mockReturnValue(celebratedAt);
    rerender(<OkBlob celebrateSignal={1} trackMouse={false} />);
    const celebration = container.querySelector('[data-slot="ok-blob-burst"]');
    expect(celebration).toBeTruthy();
    expect(celebration).not.toBe(clickBurst);

    // Still inside the rage window, so the level holds at 3 and the stamp is
    // what decides. Measured against the original stamp this click is past
    // IDLE_RESET_MS, so without the celebration's re-stamp it detonates anew.
    now.mockReturnValue(lastClickAt + 500);
    expect(lastClickAt + 500 - (T0 + 200)).toBeGreaterThan(IDLE_RESET_MS);
    fireEvent.click(svg);
    expect(container.querySelector('[data-slot="ok-blob-burst"]')).toBe(celebration);
    now.mockRestore();
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
