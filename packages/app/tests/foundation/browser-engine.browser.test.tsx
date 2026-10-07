import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { Button } from '@/components/ui/button';

describe('the browser tier exposes the engine, with two Node-shaped names', () => {
  test('global names the same object as globalThis', () => {
    expect(global).toBe(globalThis);
  });

  test('assigning localStorage keeps the engine Storage object', () => {
    const engineStorage = localStorage;

    globalThis.localStorage = window.localStorage;

    expect(localStorage).toBe(engineStorage);
    expect(Object.getPrototypeOf(localStorage)).toBe(Storage.prototype);
    localStorage.setItem('round-trip', 'kept');
    expect(window.localStorage.getItem('round-trip')).toBe('kept');
  });

  test('platform APIs are the engine implementations, not emulator stand-ins', () => {
    expect(Function.prototype.toString.call(ResizeObserver)).toContain('[native code]');
    expect(window.matchMedia('(min-width: 1px)').matches).toBe(true);
    expect(navigator.userAgent).toContain('HeadlessChrome');
  });

  test('the engine lays out a row of real icon buttons from production CSS', () => {
    const view = render(
      <div data-testid="row" className="inline-flex gap-2">
        <Button size="icon" aria-label="first" />
        <Button size="icon" aria-label="second" />
        <Button size="icon" aria-label="third" />
      </div>,
    );

    const first = view.getByRole('button', { name: 'first' }).getBoundingClientRect();
    const third = view.getByRole('button', { name: 'third' }).getBoundingClientRect();
    expect([first.width, first.height]).toEqual([32, 32]);
    expect(third.left - first.left).toBe(80);
    expect(view.getByTestId('row').getBoundingClientRect().width).toBe(112);
  });

  test('vi.resetModules does not reload an ES module in the browser, so the next import returns the same instance', async () => {
    const first = await import('./fixtures/mock-subject');

    vi.resetModules();

    expect(await import('./fixtures/mock-subject')).toBe(first);
  });
});
