/**
 * Unit tests for `openExternalUrl` — the imperative external-open helper used
 * by non-anchor call sites (graph nodes, "Open link" buttons).
 *
 * Covered surfaces:
 *   (a) Electron host: forwards to `okDesktop.shell.openExternal`, NEVER opens
 *       a new in-app window via `window.open` (the bug this fixes — external
 *       graph links were opening inside Open Knowledge instead of the OS
 *       default browser).
 *   (b) Web host (no bridge): falls through to
 *       `window.open(url, '_blank', 'noopener,noreferrer')`.
 */

import { describe, expect, mock, test } from 'bun:test';
import { openExternalUrl } from './external-link.ts';

describe('openExternalUrl — Electron host', () => {
  test('routes through okDesktop.shell.openExternal and does NOT open a new window', () => {
    const openExternal = mock(async () => {});
    const openWindow = mock(() => null);
    openExternalUrl('https://youtube.com/watch?v=abc', {
      okDesktop: { shell: { openExternal } },
      openWindow,
    });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://youtube.com/watch?v=abc');
    expect(openWindow).not.toHaveBeenCalled();
  });
});

describe('openExternalUrl — web host (no bridge)', () => {
  test('falls back to window.open with the new-tab + noopener features', () => {
    const openWindow = mock(() => null);
    openExternalUrl('https://example.com', { okDesktop: undefined, openWindow });
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
  });

  test('falls back to window.open when the bridge has no openExternal', () => {
    const openWindow = mock(() => null);
    openExternalUrl('https://example.com', { okDesktop: { shell: {} }, openWindow });
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
  });
});

describe('openExternalUrl — structural scheme gate (internal)', () => {
  test('an unsafe scheme is refused on the web path — never reaches window.open', () => {
    const openWindow = mock(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: exercising the security gate with a hostile scheme
    openExternalUrl('javascript:alert(1)' as any, { okDesktop: undefined, openWindow });
    expect(openWindow).not.toHaveBeenCalled();
  });

  test('an unsafe scheme is refused on the desktop path — never reaches the bridge', () => {
    const openExternal = mock(() => Promise.resolve());
    // biome-ignore lint/suspicious/noExplicitAny: exercising the security gate with a hostile scheme
    openExternalUrl('javascript:alert(1)' as any, { okDesktop: { shell: { openExternal } } });
    expect(openExternal).not.toHaveBeenCalled();
  });
});
