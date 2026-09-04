import { render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLOR_THEME_ATTRIBUTE } from '@/lib/use-apply-config-color-theme';
import { computeLiveXtermTheme } from './terminal-theme';
import { useLiveXtermTheme } from './use-live-xterm-theme';

describe('useLiveXtermTheme frame coalescing', () => {
  let reads = 0;

  function Probe() {
    useLiveXtermTheme('dark');
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
      reads += 1;
      return real(el);
    }) as typeof window.getComputedStyle);
    reads = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.documentElement.removeAttribute(COLOR_THEME_ATTRIBUTE);
    document.documentElement.classList.remove('dark');
    document.getElementById('coalescing-probe-style')?.remove();
  });

  function readsPerRecompute(): number {
    reads = 0;
    computeLiveXtermTheme('dark');
    expect(reads).toBeGreaterThan(0);
    return reads;
  }

  it('collapses a burst of watched mutations into one recompute per frame', async () => {
    const perRecompute = readsPerRecompute();
    const view = render(<Probe />);
    reads = 0;

    await act(async () => {
      document.documentElement.setAttribute(COLOR_THEME_ATTRIBUTE, 'gruvbox');
      await Promise.resolve();
      document.documentElement.classList.add('dark');
      await Promise.resolve();
      const style = document.createElement('style');
      style.id = 'coalescing-probe-style';
      document.head.appendChild(style);
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersToNextFrame();
    });

    expect(reads).toBe(perRecompute);
    view.unmount();
  });

  it('does not recompute after unmount for a frame already scheduled', async () => {
    const view = render(<Probe />);
    document.documentElement.setAttribute(COLOR_THEME_ATTRIBUTE, 'nord');
    await act(async () => {
      await Promise.resolve();
    });

    reads = 0;
    view.unmount();
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });

    expect(reads).toBe(0);
  });

  it('recomputes synchronously where requestAnimationFrame is unavailable', async () => {
    vi.useRealTimers();
    vi.stubGlobal('requestAnimationFrame', undefined);
    const perRecompute = readsPerRecompute();

    const view = render(<Probe />);
    reads = 0;
    document.documentElement.setAttribute(COLOR_THEME_ATTRIBUTE, 'gruvbox');
    await act(async () => {
      await Promise.resolve();
    });

    expect(reads).toBe(perRecompute);
    view.unmount();
  });
});
