import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeLiveXtermTheme, liveTokenReaderForEpoch } from './terminal-theme';

describe('computeLiveXtermTheme default token reader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  const spansInBody = () => document.body.getElementsByTagName('span').length;

  it('attaches every probe before reading any of them', () => {
    const attachedAtRead: number[] = [];
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
      attachedAtRead.push(spansInBody());
      return real(el);
    }) as typeof window.getComputedStyle);

    computeLiveXtermTheme('dark');

    expect(attachedAtRead.length).toBeGreaterThan(1);
    expect(attachedAtRead[0]).toBe(attachedAtRead.length);
    expect(new Set(attachedAtRead).size).toBe(1);
  });

  it('removes every probe once the batch is read', () => {
    computeLiveXtermTheme('dark');
    expect(spansInBody()).toBe(0);
  });

  it('shares one token read across terminal consumers in a frame', async () => {
    let reads = 0;
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
      reads += 1;
      return real(el);
    }) as typeof window.getComputedStyle);

    const reader = liveTokenReaderForEpoch(10_001);
    computeLiveXtermTheme('dark', reader);
    const readsForEpoch = reads;
    computeLiveXtermTheme('dark', liveTokenReaderForEpoch(10_001));

    expect(readsForEpoch).toBeGreaterThan(0);
    expect(reads).toBe(readsForEpoch);
    const paletteStyle = document.createElement('style');
    document.head.appendChild(paletteStyle);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    paletteStyle.remove();
    computeLiveXtermTheme('dark', liveTokenReaderForEpoch(10_001));
    expect(reads).toBeGreaterThan(readsForEpoch);
    const readsAfterFrame = reads;
    computeLiveXtermTheme('dark', liveTokenReaderForEpoch(10_002));
    expect(reads).toBeGreaterThan(readsAfterFrame);
  });
});
