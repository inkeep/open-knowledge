import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { subscribeColorThemeEpoch, useColorThemeEpoch } from './color-theme-epoch';

function Probe() {
  const epoch = useColorThemeEpoch();
  return <div data-testid="epoch">{epoch}</div>;
}

function epochOf(view: ReturnType<typeof render>): number {
  return Number(view.getByTestId('epoch').textContent);
}

async function setColorThemeAndFlush(value: string): Promise<void> {
  await act(async () => {
    document.documentElement.setAttribute('data-color-theme', value);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

describe('useColorThemeEpoch', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-color-theme');
  });

  test('bumps when the data-color-theme attribute changes', async () => {
    const view = render(<Probe />);
    const before = epochOf(view);
    await setColorThemeAndFlush('dracula');
    expect(epochOf(view)).toBeGreaterThan(before);
  });

  test('tears the observer down when all subscribers leave and re-creates it on remount', async () => {
    const first = render(<Probe />);
    await setColorThemeAndFlush('dracula');
    first.unmount();

    const second = render(<Probe />);
    const before = epochOf(second);
    await setColorThemeAndFlush('monokai');
    expect(epochOf(second)).toBeGreaterThan(before);
  });

  test('ignores descendant transition events', async () => {
    const view = render(<Probe />);
    const before = epochOf(view);
    const child = document.createElement('div');
    document.body.appendChild(child);
    const event = new Event('transitionrun', { bubbles: true });
    Object.defineProperty(event, 'propertyName', { value: '--background' });

    await act(async () => {
      child.dispatchEvent(event);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(epochOf(view)).toBe(before);
    child.remove();
  });

  test('samples active fades and their final frame, then stops on settlement or unsubscribe', async () => {
    const originalGetAnimations = document.documentElement.getAnimations;
    let active = true;
    document.documentElement.getAnimations = () =>
      active ? ([{ transitionProperty: '--background' }] as unknown as Animation[]) : [];
    let samples = 0;
    const unsubscribe = subscribeColorThemeEpoch(() => {
      samples += 1;
    });
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      await nextFrame();
      const first = samples;
      await nextFrame();
      expect(samples).toBeGreaterThan(first);
      active = false;
      const beforeSettlement = samples;
      await nextFrame();
      expect(samples).toBe(beforeSettlement + 1);
      await nextFrame();
      expect(samples).toBe(beforeSettlement + 1);
      active = true;
      const event = new Event('transitionrun');
      Object.defineProperty(event, 'propertyName', { value: '--background' });
      document.documentElement.dispatchEvent(event);
      unsubscribe();
      await nextFrame();
      expect(samples).toBe(beforeSettlement + 1);
    } finally {
      unsubscribe();
      document.documentElement.getAnimations = originalGetAnimations;
    }
  });
});
