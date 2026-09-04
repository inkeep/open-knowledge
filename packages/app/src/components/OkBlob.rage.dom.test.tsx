import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { OkBlob } from './OkBlob';
import { IDLE_RESET_MS, RAGE_WINDOW_MS } from './ok-blob-logic';

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
    expect(container.querySelector('[data-slot="ok-blob-burst"]')).toBe(burst);
  });

  test('a click past the burst lifetime earns a fresh burst', () => {
    const now = vi.spyOn(performance, 'now');
    const { container } = render(<OkBlob trackMouse={false} />);
    const svg = blob(container);

    const T0 = 1_000;
    now.mockReturnValue(T0);
    fireEvent.click(svg);
    now.mockReturnValue(T0 + 100);
    fireEvent.click(svg);
    now.mockReturnValue(T0 + 200);
    fireEvent.click(svg);
    const first = container.querySelector('[data-slot="ok-blob-burst"]');
    expect(first).toBeTruthy();

    now.mockReturnValue(T0 + 400);
    fireEvent.click(svg);
    expect(container.querySelector('[data-slot="ok-blob-burst"]')).toBe(first);

    const burstStartedAt = T0 + 200;
    for (let t = T0 + 900; t < burstStartedAt + IDLE_RESET_MS; t += 500) {
      now.mockReturnValue(t);
      fireEvent.click(svg);
      expect(container.querySelector('[data-slot="ok-blob-burst"]')).toBe(first);
    }

    now.mockReturnValue(burstStartedAt + IDLE_RESET_MS + 1);
    fireEvent.click(svg);
    const second = container.querySelector('[data-slot="ok-blob-burst"]');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    now.mockRestore();
  });

  test('a celebration landing on a live streak keeps its burst', () => {
    const now = vi.spyOn(performance, 'now');
    const T0 = 1_000;
    const { container, rerender } = render(<OkBlob celebrateSignal={0} trackMouse={false} />);
    const svg = blob(container);

    now.mockReturnValue(T0);
    fireEvent.click(svg);
    now.mockReturnValue(T0 + 100);
    fireEvent.click(svg);
    now.mockReturnValue(T0 + 200);
    fireEvent.click(svg);
    const clickBurst = container.querySelector('[data-slot="ok-blob-burst"]');
    expect(clickBurst).toBeTruthy();

    let t = T0 + 700;
    for (; t < T0 + 200 + IDLE_RESET_MS; t += 500) {
      now.mockReturnValue(t);
      fireEvent.click(svg);
    }
    const lastClickAt = t - 500;

    const celebratedAt = lastClickAt + 50;
    now.mockReturnValue(celebratedAt);
    rerender(<OkBlob celebrateSignal={1} trackMouse={false} />);
    const celebration = container.querySelector('[data-slot="ok-blob-burst"]');
    expect(celebration).toBeTruthy();
    expect(celebration).not.toBe(clickBurst);

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
    rerender(<OkBlob onRage={onRage} celebrateSignal={1} trackMouse={false} />);
    expect(onRage).not.toHaveBeenCalled();
  });
});
