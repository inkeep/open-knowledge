import { describe, expect, mock, test } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  attachRemoteEditorTrustBoundary,
  isRemoteProjectApiUrl,
  isSafeRemoteExternalUrl,
  isTrustedRemoteEditorUrl,
  type RemoteEditorRendererTarget,
} from '../../src/main/remote-editor-trust-boundary.ts';

const PACKAGED_ENTRY = resolve(
  '/Applications/Open Knowledge.app/Contents/Resources/app/index.html',
);
const PACKAGED_TARGET: RemoteEditorRendererTarget = {
  rendererEntryPath: PACKAGED_ENTRY,
  rendererDevUrl: null,
};
const DEV_TARGET: RemoteEditorRendererTarget = {
  rendererEntryPath: '/unused/index.html',
  rendererDevUrl: 'http://localhost:5173/',
};
const API_ORIGIN = 'http://127.0.0.1:45123';

describe('isTrustedRemoteEditorUrl', () => {
  test('packaged mode trusts only the exact renderer file with query/hash state', () => {
    const entryUrl = pathToFileURL(PACKAGED_ENTRY).href;
    expect(isTrustedRemoteEditorUrl(entryUrl, PACKAGED_TARGET)).toBe(true);
    expect(isTrustedRemoteEditorUrl(`${entryUrl}?v=1#/doc`, PACKAGED_TARGET)).toBe(true);

    expect(
      isTrustedRemoteEditorUrl(
        pathToFileURL(
          resolve('/Applications/Open Knowledge.app/Contents/Resources/app/remote.html'),
        ).href,
        PACKAGED_TARGET,
      ),
    ).toBe(false);
    expect(isTrustedRemoteEditorUrl('data:text/html,<script></script>', PACKAGED_TARGET)).toBe(
      false,
    );
    expect(isTrustedRemoteEditorUrl('blob:null/abc', PACKAGED_TARGET)).toBe(false);
    expect(isTrustedRemoteEditorUrl('about:blank', PACKAGED_TARGET)).toBe(false);
  });

  test('dev mode trusts only the configured Vite scheme and origin', () => {
    expect(isTrustedRemoteEditorUrl('http://localhost:5173/', DEV_TARGET)).toBe(true);
    expect(isTrustedRemoteEditorUrl('http://localhost:5173/@vite/client?t=1', DEV_TARGET)).toBe(
      true,
    );
    expect(isTrustedRemoteEditorUrl('http://localhost:5173/#/doc', DEV_TARGET)).toBe(true);

    expect(isTrustedRemoteEditorUrl('https://localhost:5173/', DEV_TARGET)).toBe(false);
    expect(isTrustedRemoteEditorUrl('http://localhost:5174/', DEV_TARGET)).toBe(false);
    expect(isTrustedRemoteEditorUrl('blob:http://localhost:5173/abc', DEV_TARGET)).toBe(false);
    expect(isTrustedRemoteEditorUrl('not a URL', DEV_TARGET)).toBe(false);
  });
});

describe('remote destination classification', () => {
  test('recognizes the tunnel origin and equivalent loopback aliases on its port', () => {
    expect(isRemoteProjectApiUrl(`${API_ORIGIN}/notes/attack.html`, API_ORIGIN)).toBe(true);
    expect(isRemoteProjectApiUrl('http://localhost:45123/notes/attack.html', API_ORIGIN)).toBe(
      true,
    );
    expect(isRemoteProjectApiUrl('http://127.0.0.2:45123/raw.htm', API_ORIGIN)).toBe(true);
    expect(isRemoteProjectApiUrl('http://localhost.:45123/raw.htm', API_ORIGIN)).toBe(true);
    expect(isRemoteProjectApiUrl('http://wiki.localhost.:45123/raw.htm', API_ORIGIN)).toBe(true);
    expect(isRemoteProjectApiUrl('http://[::ffff:127.42.0.1]:45123/raw.htm', API_ORIGIN)).toBe(
      true,
    );
    expect(isRemoteProjectApiUrl('http://[::ffff:0.0.0.0]:45123/raw.htm', API_ORIGIN)).toBe(true);

    expect(isRemoteProjectApiUrl('http://localhost:45124/notes/attack.html', API_ORIGIN)).toBe(
      false,
    );
    expect(isRemoteProjectApiUrl('http://[::ffff:192.0.2.1]:45123/raw.htm', API_ORIGIN)).toBe(
      false,
    );
    expect(isRemoteProjectApiUrl('http://localhost.attacker.example:45123/', API_ORIGIN)).toBe(
      false,
    );
  });

  test('allows only ordinary non-loopback web/mail destinations', () => {
    expect(isSafeRemoteExternalUrl('https://docs.openknowledge.dev/guide')).toBe(true);
    expect(isSafeRemoteExternalUrl('http://example.com/guide')).toBe(true);
    expect(isSafeRemoteExternalUrl('mailto:hello@example.com')).toBe(true);
    expect(isSafeRemoteExternalUrl('http://[::ffff:192.0.2.1]/guide')).toBe(true);
    expect(isSafeRemoteExternalUrl('http://localhost.attacker.example/guide')).toBe(true);

    expect(isSafeRemoteExternalUrl('http://localhost:45123/attack.html')).toBe(false);
    expect(isSafeRemoteExternalUrl('http://localhost.:45123/attack.html')).toBe(false);
    expect(isSafeRemoteExternalUrl('http://wiki.localhost.:45123/attack.html')).toBe(false);
    expect(isSafeRemoteExternalUrl('http://[::ffff:127.42.0.1]:45123/attack.html')).toBe(false);
    expect(isSafeRemoteExternalUrl('http://[::ffff:0.0.0.0]:45123/attack.html')).toBe(false);
    expect(isSafeRemoteExternalUrl('http://127.0.0.1:9000/admin')).toBe(false);
    expect(isSafeRemoteExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeRemoteExternalUrl('data:text/html,attack')).toBe(false);
    expect(isSafeRemoteExternalUrl('blob:null/attack')).toBe(false);
    expect(isSafeRemoteExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeRemoteExternalUrl('openknowledge://open?project=/tmp/private')).toBe(false);
    expect(isSafeRemoteExternalUrl('codex://new?path=/tmp/private')).toBe(false);
  });
});

describe('attachRemoteEditorTrustBoundary', () => {
  function makeHarness(target: RemoteEditorRendererTarget = DEV_TARGET) {
    let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
    let navigateHandler: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    const openExternal = mock(async (_url: string) => {});
    const executeJavaScript = mock(async (_code: string) => {});
    const log = mock(() => {});
    const webContents = {
      setWindowOpenHandler: mock((handler: (details: { url: string }) => { action: 'deny' }) => {
        openHandler = handler;
      }),
      on: mock(
        (
          _event: 'will-navigate',
          handler: (event: { preventDefault(): void }, url: string) => void,
        ) => {
          navigateHandler = handler;
        },
      ),
      executeJavaScript,
    };
    attachRemoteEditorTrustBoundary(webContents, target, {
      apiOrigin: API_ORIGIN,
      openExternal,
      log,
    });
    return {
      open: (url: string) => openHandler?.({ url }),
      navigate: (url: string) => {
        const preventDefault = mock(() => {});
        navigateHandler?.({ preventDefault }, url);
        return preventDefault;
      },
      executeJavaScript,
      openExternal,
      log,
      webContents,
    };
  }

  test('denies every child window while preserving trusted in-app hash navigation', () => {
    const harness = makeHarness();
    expect(harness.open('http://localhost:5173/#/doc')).toEqual({ action: 'deny' });
    expect(harness.executeJavaScript).toHaveBeenCalledWith('window.location.hash = "#/doc";');

    expect(harness.open(`${API_ORIGIN}/notes/attack.html`)).toEqual({ action: 'deny' });
    expect(harness.open('http://localhost:45123/raw.htm')).toEqual({ action: 'deny' });
    expect(harness.open('http://localhost.:45123/raw.htm')).toEqual({ action: 'deny' });
    expect(harness.open('http://[::ffff:127.42.0.1]:45123/raw.htm')).toEqual({ action: 'deny' });
    expect(harness.openExternal).not.toHaveBeenCalled();

    expect(harness.open('https://example.com/guide')).toEqual({ action: 'deny' });
    expect(harness.openExternal).toHaveBeenCalledTimes(1);
    expect(harness.openExternal).toHaveBeenCalledWith('https://example.com/guide');

    expect(harness.open('file:///tmp/attack.html')).toEqual({ action: 'deny' });
    expect(harness.open('data:text/html,attack')).toEqual({ action: 'deny' });
    expect(harness.open('blob:null/attack')).toEqual({ action: 'deny' });
    expect(harness.open('openknowledge://open?project=/tmp/private')).toEqual({ action: 'deny' });
    expect(harness.openExternal).toHaveBeenCalledTimes(1);
  });

  test('allows only renderer top-level navigation and prevents remote or opaque documents', () => {
    const harness = makeHarness();
    const rendererPrevent = harness.navigate('http://localhost:5173/@vite/client?t=2');
    expect(rendererPrevent).not.toHaveBeenCalled();

    for (const url of [
      `${API_ORIGIN}/notes/attack.html`,
      'http://localhost:45123/notes/attack.html',
      'http://localhost.:45123/notes/attack.html',
      'http://[::ffff:127.42.0.1]:45123/notes/attack.html',
      'file:///tmp/attack.html',
      'data:text/html,attack',
      'blob:null/attack',
      'javascript:alert(1)',
      'not a URL',
    ]) {
      expect(harness.navigate(url)).toHaveBeenCalledTimes(1);
    }
    expect(harness.openExternal).not.toHaveBeenCalled();

    const externalPrevent = harness.navigate('https://example.com/guide');
    expect(externalPrevent).toHaveBeenCalledTimes(1);
    expect(harness.openExternal).toHaveBeenCalledTimes(1);
    expect(harness.openExternal).toHaveBeenCalledWith('https://example.com/guide');
  });

  test('pins packaged navigation to the exact renderer entry, not null-origin peers', () => {
    const harness = makeHarness(PACKAGED_TARGET);
    const entry = pathToFileURL(PACKAGED_ENTRY).href;
    expect(harness.navigate(`${entry}#/doc`)).not.toHaveBeenCalled();
    expect(harness.navigate('file:///tmp/remote.html')).toHaveBeenCalledTimes(1);
    expect(harness.navigate('data:text/html,attack')).toHaveBeenCalledTimes(1);
    expect(harness.navigate('blob:null/attack')).toHaveBeenCalledTimes(1);
  });

  test('attaches both defenses synchronously and rejects an invalid API origin', () => {
    const harness = makeHarness();
    expect(harness.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    expect(harness.webContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));

    expect(() =>
      attachRemoteEditorTrustBoundary(harness.webContents, DEV_TARGET, {
        apiOrigin: 'not a URL',
        openExternal: harness.openExternal,
      }),
    ).toThrow('invalid API origin');
  });
});
