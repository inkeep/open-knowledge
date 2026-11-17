import { afterEach, describe, expect, test } from 'vitest';
import { matchAssetUrl, toDesktopAssetHref } from './asset-href.ts';

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

const ORIGIN = 'http://localhost:5173';

describe('matchAssetUrl', () => {
  test('same-origin asset URL → project-relative path', () => {
    expect(matchAssetUrl('http://localhost:5173/notes/meeting.pdf', ORIGIN)).toBe(
      'notes/meeting.pdf',
    );
  });

  test('nested subdir asset → full relative path', () => {
    expect(matchAssetUrl('http://localhost:5173/docs/assets/photo.png', ORIGIN)).toBe(
      'docs/assets/photo.png',
    );
  });

  test('different origin (https external) → null', () => {
    expect(matchAssetUrl('https://example.com/notes/meeting.pdf', ORIGIN)).toBeNull();
  });

  test('app bundle (index.html) → null', () => {
    expect(matchAssetUrl('http://localhost:5173/index.html', ORIGIN)).toBeNull();
  });

  test('content html/htm → null (handled by the renderer dispatcher, not the safety net)', () => {
    expect(matchAssetUrl('http://localhost:5173/fishing-log/trip-viewer.html', ORIGIN)).toBeNull();
    expect(matchAssetUrl('http://localhost:5173/notes/legacy.htm', ORIGIN)).toBeNull();
  });

  test('app bundle without explicit path → null', () => {
    expect(matchAssetUrl('http://localhost:5173/', ORIGIN)).toBeNull();
  });

  test('Vite HMR client (/@vite/client) → null', () => {
    expect(matchAssetUrl('http://localhost:5173/@vite/client', ORIGIN)).toBeNull();
  });

  test('extensionless path → null', () => {
    expect(matchAssetUrl('http://localhost:5173/api/document', ORIGIN)).toBeNull();
  });

  test('non-asset extension (.ts, .js, .css) → null', () => {
    expect(matchAssetUrl('http://localhost:5173/src/main.ts', ORIGIN)).toBeNull();
    expect(matchAssetUrl('http://localhost:5173/styles.css', ORIGIN)).toBeNull();
  });

  test('bogus URL → null (no throw)', () => {
    expect(matchAssetUrl('not a url', ORIGIN)).toBeNull();
  });

  test('PDF via alternate localhost port still matches if origin matches', () => {
    expect(matchAssetUrl('http://localhost:9999/notes/meeting.pdf', 'http://localhost:9999')).toBe(
      'notes/meeting.pdf',
    );
  });

  test('percent-encoded space in filename decodes to literal space', () => {
    expect(matchAssetUrl('http://localhost:5173/my%20photo.png', ORIGIN)).toBe('my photo.png');
  });

  test('percent-encoded Unicode (Japanese) decodes to literal characters', () => {
    expect(matchAssetUrl('http://localhost:5173/%E6%97%A5%E6%9C%AC.pdf', ORIGIN)).toBe('日本.pdf');
  });

  test('malformed percent-encoding → null (no throw)', () => {
    expect(matchAssetUrl('http://localhost:5173/%ZZ.png', ORIGIN)).toBeNull();
    expect(matchAssetUrl('http://localhost:5173/%E0%A4.png', ORIGIN)).toBeNull();
  });

  test('encoded traversal (`%2E%2E`) is canonicalized by the URL parser', () => {
    expect(matchAssetUrl('http://localhost:5173/%2E%2E/secret.pdf', ORIGIN)).toBe('secret.pdf');
  });
});
