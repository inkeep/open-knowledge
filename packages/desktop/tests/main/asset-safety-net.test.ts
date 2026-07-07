/**
 * Unit tests for the main-process asset safety net. Covers the two-handler
 * intercept pattern (`setWindowOpenHandler` + `will-navigate`) and the
 * URL-matching logic that distinguishes asset URLs from app / Vite-HMR /
 * external URLs.
 */

import { describe, expect, mock, test } from 'bun:test';
import {
  attachAssetSafetyNet,
  matchAssetUrl,
  matchInAppRoute,
} from '../../src/main/asset-safety-net.ts';

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
    // html/htm are admitted assets but the safety net must NOT claim them — the
    // app shell shares `index.html`, and content-html clicks route through the
    // renderer dispatcher (desktop: reveal-in-Finder).
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
    // .js is in EXECUTABLE_BLOCKLIST_EXTENSIONS but NOT in ASSET_EXTENSIONS.
    // The safety net delegates to the main-process handler for ASSET_EXTENSIONS
    // only; anything else stays on the default nav path where additional
    // handlers (Vite HMR, app-bundle fetch) claim it.
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
    // `URL.pathname` percent-encodes spaces; openAssetSafely needs the
    // decoded string for `realpathSync` to find the actual file.
    expect(matchAssetUrl('http://localhost:5173/my%20photo.png', ORIGIN)).toBe('my photo.png');
  });

  test('percent-encoded Unicode (Japanese) decodes to literal characters', () => {
    expect(matchAssetUrl('http://localhost:5173/%E6%97%A5%E6%9C%AC.pdf', ORIGIN)).toBe('日本.pdf');
  });

  test('malformed percent-encoding → null (no throw)', () => {
    // `decodeURIComponent('%ZZ.png')` throws URIError — refuse rather
    // than forward a partially-decoded string downstream.
    expect(matchAssetUrl('http://localhost:5173/%ZZ.png', ORIGIN)).toBeNull();
    expect(matchAssetUrl('http://localhost:5173/%E0%A4.png', ORIGIN)).toBeNull();
  });

  test('encoded traversal (`%2E%2E`) is canonicalized by the URL parser', () => {
    // WHATWG URL parser resolves `.` / `..` segments during pathname
    // canonicalization, so `/%2E%2E/secret.pdf` becomes `/secret.pdf`
    // before our decode step ever sees it. The result is a clean,
    // contained path — no traversal reaches downstream. (The
    // `isPathWithinProject` containment check in `asset-allowlist.ts`
    // is the second layer that catches any traversal that does slip
    // through, e.g. via symlink at the destination.)
    expect(matchAssetUrl('http://localhost:5173/%2E%2E/secret.pdf', ORIGIN)).toBe('secret.pdf');
  });
});

describe('matchInAppRoute', () => {
  test('same-renderer-origin hash route → returns the hash', () => {
    expect(
      matchInAppRoute('http://localhost:5173/#/people/ray-zaragoza', 'http://localhost:5173'),
    ).toBe('#/people/ray-zaragoza');
  });

  test('different origin (renderer route vs api/editor port) → null', () => {
    // The leak case: the route origin is the renderer (:5173), NOT editorOrigin.
    // matchInAppRoute is fed the renderer origin, so an external host or the api
    // port → null and the URL stays on whatever path the caller chose.
    expect(matchInAppRoute('http://localhost:5173/#/doc', 'http://localhost:8765')).toBeNull();
  });

  test('same origin but non-hash URL (bundle entry) → null', () => {
    expect(matchInAppRoute('http://localhost:5173/index.html', 'http://localhost:5173')).toBeNull();
  });

  test('null renderer origin (URL not yet loaded) → null', () => {
    expect(matchInAppRoute('http://localhost:5173/#/doc', null)).toBeNull();
  });

  test('bogus URL → null (no throw)', () => {
    expect(matchInAppRoute('not a url', 'http://localhost:5173')).toBeNull();
  });
});

function noopOpenExternal(_: string): Promise<void> {
  return Promise.resolve();
}

describe('attachAssetSafetyNet — setWindowOpenHandler', () => {
  test('asset URL new-window request → denied + openAsset fires', async () => {
    const openAsset = mock(async (_: string) => ({ ok: true }) as const);
    const openExternal = mock(noopOpenExternal);
    const log = mock((_: unknown) => {});

    let installedHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | null =
      null;
    const webContents = {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }) {
        installedHandler = handler;
      },
      on: () => {},
    };

    attachAssetSafetyNet(webContents, { openAsset, openExternal, editorOrigin: ORIGIN, log });

    const result = installedHandler?.({
      url: 'http://localhost:5173/notes/meeting.pdf',
    });
    expect(result).toEqual({ action: 'deny' });

    // Allow the async openAsset to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(openAsset).toHaveBeenCalledWith('notes/meeting.pdf');
    expect(openExternal).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test('cross-origin https new-window → denied + openExternal fires', async () => {
    const openAsset = mock(async (_: string) => ({ ok: true }) as const);
    const openExternal = mock(noopOpenExternal);

    let installedHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | null =
      null;
    const webContents = {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }) {
        installedHandler = handler;
      },
      on: () => {},
    };

    attachAssetSafetyNet(webContents, { openAsset, openExternal, editorOrigin: ORIGIN });

    // Pasted-href / markdown PropPanel "Open in new tab" path.
    const result = installedHandler?.({ url: 'https://example.com/path' });
    expect(result).toEqual({ action: 'deny' });
    await Promise.resolve();
    expect(openAsset).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/path');
  });

  test('disallowed scheme new-window (javascript:) → denied + openExternal throw is logged', async () => {
    const openAsset = mock(async (_: string) => ({ ok: true }) as const);
    const openExternal = mock(async (_: string) => {
      throw new Error('shell.openExternal blocked: scheme-not-allowed: javascript:');
    });
    const logEvents: unknown[] = [];

    let installedHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | null =
      null;
    const webContents = {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }) {
        installedHandler = handler;
      },
      on: () => {},
    };

    attachAssetSafetyNet(webContents, {
      openAsset,
      openExternal,
      editorOrigin: ORIGIN,
      log: (evt) => logEvents.push(evt),
    });

    const result = installedHandler?.({ url: 'javascript:alert(1)' });
    expect(result).toEqual({ action: 'deny' });
    await Promise.resolve();
    await Promise.resolve();
    expect(openAsset).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('javascript:alert(1)');
    expect(logEvents).toHaveLength(1);
    expect(logEvents[0]).toMatchObject({
      level: 'warn',
      message: 'openExternal refused from setWindowOpenHandler',
    });
  });

  test('openAsset refusal (path-escape on pdf) is logged', async () => {
    const openAsset = mock(async (_: string) => ({ ok: false, reason: 'path-escape' }) as const);
    const openExternal = mock(noopOpenExternal);
    const logEvents: unknown[] = [];
    const log = (evt: unknown) => {
      logEvents.push(evt);
    };

    let installedHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | null =
      null;
    const webContents = {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }) {
        installedHandler = handler;
      },
      on: () => {},
    };

    attachAssetSafetyNet(webContents, { openAsset, openExternal, editorOrigin: ORIGIN, log });

    installedHandler?.({ url: 'http://localhost:5173/notes/meeting.pdf' });
    await Promise.resolve();
    await Promise.resolve();
    expect(logEvents).toHaveLength(1);
    expect(logEvents[0]).toMatchObject({
      level: 'warn',
      data: { reason: 'path-escape' },
    });
  });

  test('same-renderer-origin in-app route (open-in-new-tab) → navigated in-app, NOT openExternal', async () => {
    // Reproduces the dev tab-flood: the renderer is served at :5173 while
    // editorOrigin (apiOrigin) is a separate port. `window.open('#/doc')`
    // resolves to a :5173 route — which must navigate the current window in-app,
    // not leak to the OS browser.
    const openAsset = mock(async (_: string) => ({ ok: true }) as const);
    const openExternal = mock(noopOpenExternal);
    const executeJavaScript = mock(async (_: string) => undefined);

    let installedHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | null =
      null;
    const webContents = {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }) {
        installedHandler = handler;
      },
      on: () => {},
      getURL: () => 'http://localhost:5173/#/home',
      executeJavaScript,
    };

    attachAssetSafetyNet(webContents, {
      openAsset,
      openExternal,
      editorOrigin: 'http://localhost:8765',
    });

    const result = installedHandler?.({ url: 'http://localhost:5173/#/people/ray-zaragoza' });
    expect(result).toEqual({ action: 'deny' });
    await Promise.resolve();
    await Promise.resolve();
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    // Pin the exact script, not just a substring: `navigateToHashScript`'s
    // `JSON.stringify` is the injection guard for the `executeJavaScript` input,
    // so the assertion must fail if a refactor drops the encoding.
    expect(executeJavaScript.mock.calls[0]?.[0]).toBe(
      'window.location.hash = "#/people/ray-zaragoza";',
    );
    expect(openExternal).not.toHaveBeenCalled();
    expect(openAsset).not.toHaveBeenCalled();
  });

  test('cross-origin new-window with renderer URL present → still openExternal (not in-app)', async () => {
    const openAsset = mock(async (_: string) => ({ ok: true }) as const);
    const openExternal = mock(noopOpenExternal);
    const executeJavaScript = mock(async (_: string) => undefined);

    let installedHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | null =
      null;
    const webContents = {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }) {
        installedHandler = handler;
      },
      on: () => {},
      getURL: () => 'http://localhost:5173/#/home',
      executeJavaScript,
    };

    attachAssetSafetyNet(webContents, {
      openAsset,
      openExternal,
      editorOrigin: 'http://localhost:8765',
    });

    installedHandler?.({ url: 'https://example.com/path' });
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/path');
    expect(executeJavaScript).not.toHaveBeenCalled();
  });
});

describe('attachAssetSafetyNet — will-navigate', () => {
  test('asset URL navigation → preventDefault + openAsset fires', async () => {
    const openAsset = mock(async (_: string) => ({ ok: true }) as const);
    const openExternal = mock(noopOpenExternal);

    let installedHandler: ((event: { preventDefault: () => void }, url: string) => void) | null =
      null;
    const webContents = {
      setWindowOpenHandler: () => {},
      on(
        event: 'will-navigate',
        handler: (event: { preventDefault: () => void }, url: string) => void,
      ) {
        if (event === 'will-navigate') installedHandler = handler;
      },
    };

    attachAssetSafetyNet(webContents, { openAsset, openExternal, editorOrigin: ORIGIN });

    const preventDefault = mock(() => {});
    installedHandler?.({ preventDefault }, 'http://localhost:5173/notes/meeting.pdf');
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(openAsset).toHaveBeenCalledWith('notes/meeting.pdf');
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('same-origin navigation (Vite reload, app bundle) → no preventDefault, no delegation', async () => {
    const openAsset = mock(async (_: string) => ({ ok: true }) as const);
    const openExternal = mock(noopOpenExternal);

    let installedHandler: ((event: { preventDefault: () => void }, url: string) => void) | null =
      null;
    const webContents = {
      setWindowOpenHandler: () => {},
      on(
        event: 'will-navigate',
        handler: (event: { preventDefault: () => void }, url: string) => void,
      ) {
        if (event === 'will-navigate') installedHandler = handler;
      },
    };

    attachAssetSafetyNet(webContents, { openAsset, openExternal, editorOrigin: ORIGIN });

    const preventDefault = mock(() => {});
    installedHandler?.({ preventDefault }, 'http://localhost:5173/');
    expect(preventDefault).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(openAsset).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('same-renderer-origin navigation (distinct from editorOrigin) → no preventDefault, no delegation', async () => {
    // Renderer origin (:5173) differs from editorOrigin (api port) in dev; a
    // top-level navigate to a :5173 route must stay in-app, not openExternal.
    const openAsset = mock(async (_: string) => ({ ok: true }) as const);
    const openExternal = mock(noopOpenExternal);

    let installedHandler: ((event: { preventDefault: () => void }, url: string) => void) | null =
      null;
    const webContents = {
      setWindowOpenHandler: () => {},
      on(
        event: 'will-navigate',
        handler: (event: { preventDefault: () => void }, url: string) => void,
      ) {
        if (event === 'will-navigate') installedHandler = handler;
      },
      getURL: () => 'http://localhost:5173/#/home',
    };

    attachAssetSafetyNet(webContents, {
      openAsset,
      openExternal,
      editorOrigin: 'http://localhost:8765',
    });

    const preventDefault = mock(() => {});
    installedHandler?.({ preventDefault }, 'http://localhost:5173/#/people/ray-zaragoza');
    expect(preventDefault).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('malformed URL → silent drop (no preventDefault, no delegation, no crash)', async () => {
    // Trust-boundary pin: `will-navigate` can fire with URLs Chromium's parser
    // accepts but WHATWG `new URL()` rejects. Both parse attempts in the
    // handler (matchAssetUrl + the origin check) fail → we leave Electron's
    // default handling alone. preventDefault here would block legitimate
    // same-origin Electron behavior; deferring to Electron's own failure mode
    // is the conservative choice. This test guards against a future refactor
    // that removes the try/catch or flips the fallback.
    const openAsset = mock(async (_: string) => ({ ok: true }) as const);
    const openExternal = mock(noopOpenExternal);

    let installedHandler: ((event: { preventDefault: () => void }, url: string) => void) | null =
      null;
    const webContents = {
      setWindowOpenHandler: () => {},
      on(
        event: 'will-navigate',
        handler: (event: { preventDefault: () => void }, url: string) => void,
      ) {
        if (event === 'will-navigate') installedHandler = handler;
      },
    };

    attachAssetSafetyNet(webContents, { openAsset, openExternal, editorOrigin: ORIGIN });

    const preventDefault = mock(() => {});
    expect(() => installedHandler?.({ preventDefault }, 'not a valid url')).not.toThrow();
    expect(preventDefault).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(openAsset).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('cross-origin navigation (pasted https link) → preventDefault + openExternal fires', async () => {
    const openAsset = mock(async (_: string) => ({ ok: true }) as const);
    const openExternal = mock(noopOpenExternal);

    let installedHandler: ((event: { preventDefault: () => void }, url: string) => void) | null =
      null;
    const webContents = {
      setWindowOpenHandler: () => {},
      on(
        event: 'will-navigate',
        handler: (event: { preventDefault: () => void }, url: string) => void,
      ) {
        if (event === 'will-navigate') installedHandler = handler;
      },
    };

    attachAssetSafetyNet(webContents, { openAsset, openExternal, editorOrigin: ORIGIN });

    const preventDefault = mock(() => {});
    installedHandler?.({ preventDefault }, 'https://example.com/page');
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(openAsset).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/page');
  });
});
