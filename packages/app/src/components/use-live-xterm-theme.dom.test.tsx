import { render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLOR_THEME_ATTRIBUTE } from '@/lib/use-apply-config-color-theme';
import { computeLiveXtermTheme } from './terminal-theme';
import { useLiveXtermTheme } from './use-live-xterm-theme';

/**
 * One theme switch lands as several watched mutations arriving across separate
 * tasks, and each recompute probes the whole palette against styles the switch
 * just invalidated. These pin the frame-coalescing that keeps that burst to a
 * single recompute.
 *
 * A recompute is counted by the probe reads it performs rather than by render
 * count: the palette resolves to the same colors either way, so the hook holds
 * theme identity stable and a coalescing regression would be invisible in
 * renders while still doing the work N times over.
 *
 * MutationObserver delivers on a microtask, so each burst is followed by an
 * awaited flush before the frame is advanced — a synchronous act() returns
 * before the observer has run and the recompute would look like it never
 * scheduled.
 */
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
    // restoreAllMocks leaves stubGlobal in place, and this config sets no
    // unstubGlobals, so an assertion that throws mid-test would strand an
    // undefined requestAnimationFrame on every test after it.
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.documentElement.removeAttribute(COLOR_THEME_ATTRIBUTE);
    document.documentElement.classList.remove('dark');
    document.getElementById('coalescing-probe-style')?.remove();
  });

  /** Reads one recompute performs, measured off the shared palette reader. */
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

    // Three watched mutations of the kind a theme switch produces: the palette
    // attribute, the forced light/dark class, and the custom-palette <style>.
    // Each is flushed separately so it arrives as its OWN observer callback.
    // Mutating them in one go is what the real burst does NOT do, and would
    // leave MutationObserver's own same-microtask batching to collapse them
    // before this hook ever sees three of anything.
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

    // All three landed before the frame ran, so the frame owes exactly one
    // recompute no matter how many callbacks asked for it.
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

    // The pending frame was cancelled on teardown, so the scheduled recompute
    // never ran against the unmounted hook's closure.
    expect(reads).toBe(0);
  });

  it('recomputes synchronously where requestAnimationFrame is unavailable', async () => {
    // Real timers, so the absence below is the branch's own condition rather
    // than an artefact of rAF being faked.
    vi.useRealTimers();
    vi.stubGlobal('requestAnimationFrame', undefined);
    const perRecompute = readsPerRecompute();

    const view = render(<Probe />);
    reads = 0;
    document.documentElement.setAttribute(COLOR_THEME_ATTRIBUTE, 'gruvbox');
    await act(async () => {
      await Promise.resolve();
    });

    // No frame to wait for, so the observer callback recomputes in line.
    expect(reads).toBe(perRecompute);
    view.unmount();
  });
});
