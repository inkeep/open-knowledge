/**
 * The Excalidraw asset-path pin must resolve relative to the document
 * under `file:` (the packaged desktop renderer loads via `loadFile`, where
 * a path-absolute `/excalidraw-assets/` resolves to the filesystem root,
 * 404s, and silently falls back to the esm.sh CDN — defeating the vendored
 * fonts). Regressing this is invisible in dev/CI, which are both `http:`.
 */

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
    // The module only pins when unset — clear any earlier pin so this
    // import exercises the assignment.
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
