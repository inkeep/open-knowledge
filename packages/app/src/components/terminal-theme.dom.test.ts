import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeLiveXtermTheme } from './terminal-theme';

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
});
