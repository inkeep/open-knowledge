import { render } from '@testing-library/react';
import type { ITheme } from '@xterm/xterm';
import { act, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeColorThemeEpoch } from '@/lib/color-theme-epoch';
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

describe('useLiveXtermTheme palette delivery', () => {
  const lightPalette = { '--background': 'rgb(255, 255, 255)', '--foreground': 'rgb(10, 10, 10)' };
  const intermediatePalette = {
    '--background': 'rgb(143, 143, 143)',
    '--foreground': 'rgb(102, 102, 102)',
  };
  const darkPalette = { '--background': 'rgb(16, 32, 48)', '--foreground': 'rgb(240, 224, 208)' };
  let palette: Record<string, string> = lightPalette;
  let transitioning = false;
  let originalGetAnimations: typeof document.documentElement.getAnimations;

  function ThemeProbe({
    onTheme,
    resolvedTheme,
  }: {
    onTheme: (theme: ITheme) => void;
    resolvedTheme: string | undefined;
  }) {
    const theme = useLiveXtermTheme(resolvedTheme);
    useEffect(() => {
      onTheme(theme);
    }, [onTheme, theme]);
    return (
      <output data-testid="terminal-palette">{`${theme.foreground}/${theme.background}`}</output>
    );
  }

  async function nextFrame(): Promise<void> {
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
  }

  async function changeTheme(name: string): Promise<void> {
    await act(async () => {
      document.documentElement.setAttribute(COLOR_THEME_ATTRIBUTE, name);
      await Promise.resolve();
    });
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    palette = lightPalette;
    transitioning = false;
    const root = document.documentElement;
    originalGetAnimations = root.getAnimations;
    root.getAnimations = () =>
      transitioning ? ([{ transitionProperty: '--background' }] as unknown as Animation[]) : [];
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((element: Element) => {
      const token = /var\((--[\w-]+)\)/.exec(element.getAttribute('style') ?? '')?.[1];
      if (!token) return real(element);
      return { backgroundColor: palette[token] ?? 'transparent' } as CSSStyleDeclaration;
    }) as typeof window.getComputedStyle);
    const unsubscribe = subscribeColorThemeEpoch(() => {});
    await changeTheme('fixture-prime');
    await nextFrame();
    unsubscribe();
    root.removeAttribute(COLOR_THEME_ATTRIBUTE);
  });

  afterEach(() => {
    document.documentElement.getAnimations = originalGetAnimations;
    document.documentElement.removeAttribute(COLOR_THEME_ATTRIBUTE);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps an established terminal palette until the custom dark palette settles', async () => {
    const received: ITheme[] = [];
    const view = render(
      <ThemeProbe resolvedTheme="dark" onTheme={(theme) => received.push(theme)} />,
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      background: '#ffffffff',
      foreground: '#0a0a0aff',
    });

    transitioning = true;
    palette = intermediatePalette;
    await changeTheme('custom-dark');
    await nextFrame();
    await nextFrame();
    expect(received).toHaveLength(1);

    transitioning = false;
    palette = darkPalette;
    await nextFrame();
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({
      background: '#102030ff',
      foreground: '#f0e0d0ff',
    });
    view.unmount();
  });

  it('keeps the settled palette when resolved mode changes during a fade', async () => {
    const received: ITheme[] = [];
    const onTheme = (theme: ITheme) => received.push(theme);
    const view = render(<ThemeProbe resolvedTheme="light" onTheme={onTheme} />);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      background: '#ffffffff',
      foreground: '#0a0a0aff',
    });

    transitioning = true;
    palette = intermediatePalette;
    view.rerender(<ThemeProbe resolvedTheme="dark" onTheme={onTheme} />);
    expect(received).toHaveLength(1);

    await changeTheme('custom-dark');
    await nextFrame();
    expect(received).toHaveLength(1);

    transitioning = false;
    palette = darkPalette;
    await nextFrame();
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({
      background: '#102030ff',
      foreground: '#f0e0d0ff',
    });
    view.unmount();
  });

  it.each([
    { mode: 'light', resolvedTheme: 'light', background: '#ffffff', foreground: '#262626' },
    { mode: 'dark', resolvedTheme: 'dark', background: '#171717', foreground: '#e5e5e5' },
    { mode: 'unresolved', resolvedTheme: undefined, background: '#ffffff', foreground: '#262626' },
  ])(
    'initializes a newly mounted $mode terminal with readable fallback colors',
    async ({ resolvedTheme, background, foreground }) => {
      transitioning = true;
      palette = intermediatePalette;
      const received: ITheme[] = [];
      const view = render(
        <ThemeProbe resolvedTheme={resolvedTheme} onTheme={(theme) => received.push(theme)} />,
      );
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ background, foreground });

      await nextFrame();
      await nextFrame();
      expect(received).toHaveLength(1);

      transitioning = false;
      palette = darkPalette;
      await nextFrame();
      expect(received.at(-1)).toMatchObject({
        background: '#102030ff',
        foreground: '#f0e0d0ff',
      });
      view.unmount();
    },
  );

  it('preserves safe colors when a terminal unmounts and remounts during the fade', async () => {
    const first = render(<ThemeProbe resolvedTheme="dark" onTheme={() => undefined} />);
    transitioning = true;
    palette = intermediatePalette;
    await changeTheme('custom-dark');
    await nextFrame();
    first.unmount();
    await nextFrame();

    const secondReceived: ITheme[] = [];
    const second = render(
      <ThemeProbe resolvedTheme="dark" onTheme={(theme) => secondReceived.push(theme)} />,
    );
    expect(secondReceived.length).toBeGreaterThan(0);
    expect(secondReceived.map((theme) => theme.background)).not.toContain('#8f8f8fff');
    expect(secondReceived.map((theme) => theme.foreground)).not.toContain('#666666ff');

    transitioning = false;
    palette = darkPalette;
    await nextFrame();
    expect(secondReceived.at(-1)).toMatchObject({
      background: '#102030ff',
      foreground: '#f0e0d0ff',
    });
    second.unmount();
  });

  it('applies a changed palette on the next frame when no root color animation runs', async () => {
    const received: ITheme[] = [];
    const view = render(
      <ThemeProbe resolvedTheme="dark" onTheme={(theme) => received.push(theme)} />,
    );
    palette = darkPalette;
    await changeTheme('custom-dark');
    await nextFrame();

    expect(received.at(-1)).toMatchObject({
      background: '#102030ff',
      foreground: '#f0e0d0ff',
    });
    view.unmount();
  });
});
