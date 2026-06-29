
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
