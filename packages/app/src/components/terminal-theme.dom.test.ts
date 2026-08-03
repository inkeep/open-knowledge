import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeLiveXtermTheme } from './terminal-theme';

/**
 * The default token reader probes the live palette through the DOM. Attaching a
 * probe re-dirties style, so reading one token at a time costs a forced style
 * recalculation per token, against styles a theme switch has just invalidated.
 * These pin the batched shape: one attach for the whole palette, then the
 * reads. The sibling `terminal-theme.test.ts` covers slot mapping and
 * fallbacks through an injected reader, which never touches this path.
 */
describe('computeLiveXtermTheme default token reader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  /** Probe spans live in <body> for the duration of the batch. */
  const spansInBody = () => document.body.getElementsByTagName('span').length;

  it('attaches every probe before reading any of them', () => {
    const attachedAtRead: number[] = [];
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
      attachedAtRead.push(spansInBody());
      return real(el);
    }) as typeof window.getComputedStyle);

    computeLiveXtermTheme('dark');

    // Sanity: the palette is read token-by-token, so there is more than one read.
    expect(attachedAtRead.length).toBeGreaterThan(1);
    // The whole batch is already attached at the FIRST read, and stays attached
    // for all of them. A probe-per-token loop would report 1 every time, so the
    // count-equals-reads check is what fails if the batching regresses.
    expect(attachedAtRead[0]).toBe(attachedAtRead.length);
    expect(new Set(attachedAtRead).size).toBe(1);
  });

  it('removes every probe once the batch is read', () => {
    computeLiveXtermTheme('dark');
    expect(spansInBody()).toBe(0);
  });
});
