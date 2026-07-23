import { afterEach, describe, expect, test } from 'vitest';
import { toDesktopAssetHref } from './asset-href.ts';

const g = globalThis as { window?: unknown };

afterEach(() => {
  delete g.window;
});

describe('toDesktopAssetHref', () => {
  test('prefixes apiOrigin onto a server-absolute src when window.okDesktop is present', () => {
    g.window = { okDesktop: { config: { apiOrigin: 'http://localhost:12345' } } };
    expect(toDesktopAssetHref('/assets/x.png')).toBe('http://localhost:12345/assets/x.png');
  });

  test('identity when window.okDesktop is absent', () => {
    expect(toDesktopAssetHref('/assets/x.png')).toBe('/assets/x.png');
  });

  test('identity when window exists but okDesktop is absent', () => {
    g.window = {};
    expect(toDesktopAssetHref('/assets/x.png')).toBe('/assets/x.png');
  });

  test('identity when apiOrigin is empty or missing', () => {
    g.window = { okDesktop: { config: {} } };
    expect(toDesktopAssetHref('/assets/x.png')).toBe('/assets/x.png');
    g.window = { okDesktop: { config: { apiOrigin: '' } } };
    expect(toDesktopAssetHref('/assets/x.png')).toBe('/assets/x.png');
  });

  test('identity for non-server-absolute srcs even with okDesktop present', () => {
    g.window = { okDesktop: { config: { apiOrigin: 'http://localhost:12345' } } };
    expect(toDesktopAssetHref('https://example.com/x.png')).toBe('https://example.com/x.png');
    expect(toDesktopAssetHref('./x.png')).toBe('./x.png');
    expect(toDesktopAssetHref('')).toBe('');
  });
});
