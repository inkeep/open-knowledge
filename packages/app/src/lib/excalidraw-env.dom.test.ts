import { afterEach, describe, expect, test, vi } from 'vitest';

const realLocation = window.location;

function stubLocation(href: string) {
  Object.defineProperty(window, 'location', {
    value: new URL(href),
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(window, 'location', {
    value: realLocation,
    writable: true,
    configurable: true,
  });
  vi.resetModules();
});

describe('excalidraw-env', () => {
  test('http pages keep the path-absolute asset root', async () => {
    window.EXCALIDRAW_ASSET_PATH = undefined;
    stubLocation('http://localhost:5173/');
    vi.resetModules();
    await import('./excalidraw-env.ts');
    expect(window.EXCALIDRAW_ASSET_PATH).toBe('/excalidraw-assets/');
  });

  test('file: pages resolve the asset root beside the document', async () => {
    window.EXCALIDRAW_ASSET_PATH = undefined;
    stubLocation('file:///Applications/OK.app/Contents/Resources/app/index.html');
    vi.resetModules();
    await import('./excalidraw-env.ts');
    expect(window.EXCALIDRAW_ASSET_PATH).toBe(
      'file:///Applications/OK.app/Contents/Resources/app/excalidraw-assets/',
    );
  });
});
