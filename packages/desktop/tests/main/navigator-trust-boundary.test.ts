import { describe, expect, mock, test } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  attachNavigatorTrustBoundary,
  isAuthorizedProjectProxyIpcSender,
  isTrustedNavigatorIpcSender,
  isTrustedNavigatorSenderFrame,
  isTrustedNavigatorUrl,
  type NavigatorRendererTarget,
} from '../../src/main/navigator-trust-boundary.ts';

const PACKAGED_ENTRY = resolve(
  '/Applications/Open Knowledge.app/Contents/Resources/app/index.html',
);
const PACKAGED_TARGET: NavigatorRendererTarget = {
  rendererEntryPath: PACKAGED_ENTRY,
  rendererDevUrl: null,
};
const DEV_TARGET: NavigatorRendererTarget = {
  rendererEntryPath: '/unused/index.html',
  rendererDevUrl: 'http://localhost:5173/',
};

describe('isTrustedNavigatorUrl', () => {
  test('packaged mode trusts only the exact loadFile entry (with optional query/hash)', () => {
    const entryUrl = pathToFileURL(PACKAGED_ENTRY).href;
    expect(isTrustedNavigatorUrl(entryUrl, PACKAGED_TARGET)).toBe(true);
    expect(isTrustedNavigatorUrl(`${entryUrl}?v=1#/open`, PACKAGED_TARGET)).toBe(true);

    expect(
      isTrustedNavigatorUrl(
        pathToFileURL(resolve('/Applications/Open Knowledge.app/Contents/Resources/app/other.html'))
          .href,
        PACKAGED_TARGET,
      ),
    ).toBe(false);
    expect(isTrustedNavigatorUrl(`${entryUrl}.attacker`, PACKAGED_TARGET)).toBe(false);
    expect(isTrustedNavigatorUrl('https://example.com/index.html', PACKAGED_TARGET)).toBe(false);
    expect(isTrustedNavigatorUrl('about:blank', PACKAGED_TARGET)).toBe(false);
  });

  test('dev mode trusts the configured HTTP origin so Vite reload/module paths keep working', () => {
    expect(isTrustedNavigatorUrl('http://localhost:5173/', DEV_TARGET)).toBe(true);
    expect(isTrustedNavigatorUrl('http://localhost:5173/@vite/client?t=1', DEV_TARGET)).toBe(true);
    expect(isTrustedNavigatorUrl('http://localhost:5173/#/navigator', DEV_TARGET)).toBe(true);

    expect(isTrustedNavigatorUrl('https://localhost:5173/', DEV_TARGET)).toBe(false);
    expect(isTrustedNavigatorUrl('http://localhost:5174/', DEV_TARGET)).toBe(false);
    expect(isTrustedNavigatorUrl('http://localhost.attacker:5173/', DEV_TARGET)).toBe(false);
    expect(isTrustedNavigatorUrl('blob:http://localhost:5173/0123', DEV_TARGET)).toBe(false);
  });

  test('fails closed for invalid URLs and invalid dev-target configuration', () => {
    expect(isTrustedNavigatorUrl(undefined, DEV_TARGET)).toBe(false);
    expect(isTrustedNavigatorUrl('not a URL', DEV_TARGET)).toBe(false);
    expect(
      isTrustedNavigatorUrl('file:///tmp/index.html', {
        rendererEntryPath: '/tmp/index.html',
        rendererDevUrl: 'file:///tmp/index.html',
      }),
    ).toBe(false);
  });
});

describe('isTrustedNavigatorSenderFrame', () => {
  function mainFrame(url: string): { url: string; parent: null } {
    return { url, parent: null };
  }

  test('accepts only a trusted top-level frame', () => {
    const trustedMain = mainFrame('http://localhost:5173/#/navigator');
    expect(isTrustedNavigatorSenderFrame(trustedMain, DEV_TARGET)).toBe(true);

    const top = mainFrame('http://localhost:5173/');
    const trustedIframe = { url: 'http://localhost:5173/frame.html', parent: top };
    expect(isTrustedNavigatorSenderFrame(trustedIframe, DEV_TARGET)).toBe(false);

    expect(isTrustedNavigatorSenderFrame(mainFrame('https://attacker.example/'), DEV_TARGET)).toBe(
      false,
    );
    expect(isTrustedNavigatorSenderFrame(null, DEV_TARGET)).toBe(false);
    expect(isTrustedNavigatorSenderFrame({ url: 'http://localhost:5173/' }, DEV_TARGET)).toBe(
      false,
    );
  });

  test('fails closed when a disposed frame accessor throws', () => {
    const frame = Object.defineProperties(
      {},
      {
        parent: { get: () => null },
        url: {
          get: () => {
            throw new Error('Render frame was disposed');
          },
        },
      },
    );
    expect(isTrustedNavigatorSenderFrame(frame, DEV_TARGET)).toBe(false);
  });
});

describe('isTrustedNavigatorIpcSender', () => {
  function mainFrame(url: string): { url: string; parent: null } {
    return { url, parent: null };
  }

  test('requires Navigator window identity plus a trusted top-level frame', () => {
    const navigator = {};
    const trustedFrame = mainFrame('http://localhost:5173/#/navigator');
    expect(isTrustedNavigatorIpcSender(navigator, navigator, trustedFrame, DEV_TARGET)).toBe(true);
    expect(isTrustedNavigatorIpcSender({}, navigator, trustedFrame, DEV_TARGET)).toBe(false);
    expect(isTrustedNavigatorIpcSender(null, navigator, trustedFrame, DEV_TARGET)).toBe(false);

    const childFrame = { url: 'http://localhost:5173/frame.html', parent: trustedFrame };
    expect(isTrustedNavigatorIpcSender(navigator, navigator, childFrame, DEV_TARGET)).toBe(false);
    expect(
      isTrustedNavigatorIpcSender(
        navigator,
        navigator,
        mainFrame('https://attacker.example/'),
        DEV_TARGET,
      ),
    ).toBe(false);
  });
});

describe('isAuthorizedProjectProxyIpcSender', () => {
  const mainFrame = (url: string): { url: string; parent: null } => ({ url, parent: null });

  test('lets the trusted Navigator proxy a selected project', () => {
    const navigator = {};
    expect(
      isAuthorizedProjectProxyIpcSender({
        callerWindow: navigator,
        navigatorWindow: navigator,
        frame: mainFrame('http://localhost:5173/#/navigator'),
        target: DEV_TARGET,
        callerProjectPath: undefined,
        requestedProjectPath: 'ssh:machine:%2Fsrv%2Fdocs',
      }),
    ).toBe(true);
  });

  test('restricts an editor to its sender-owned project', () => {
    const navigator = {};
    const editor = {};
    const base = {
      callerWindow: editor,
      navigatorWindow: navigator,
      frame: mainFrame('http://localhost:5173/'),
      target: DEV_TARGET,
      callerProjectPath: 'ssh:machine:%2Fsrv%2Fowned',
    } as const;

    expect(
      isAuthorizedProjectProxyIpcSender({
        ...base,
        requestedProjectPath: 'ssh:machine:%2Fsrv%2Fowned',
      }),
    ).toBe(true);
    expect(
      isAuthorizedProjectProxyIpcSender({
        ...base,
        requestedProjectPath: 'ssh:machine:%2Fsrv%2Fother',
      }),
    ).toBe(false);
  });

  test('rejects child, navigated, project-less, and malformed senders', () => {
    const navigator = {};
    const editor = {};
    const trustedTop = mainFrame('http://localhost:5173/');
    const common = {
      callerWindow: editor,
      navigatorWindow: navigator,
      target: DEV_TARGET,
      callerProjectPath: undefined,
      requestedProjectPath: '/projects/target',
    } as const;

    expect(
      isAuthorizedProjectProxyIpcSender({
        ...common,
        frame: { url: 'http://localhost:5173/frame.html', parent: trustedTop },
      }),
    ).toBe(false);
    expect(
      isAuthorizedProjectProxyIpcSender({
        ...common,
        callerWindow: navigator,
        frame: mainFrame('https://attacker.example/'),
      }),
    ).toBe(false);
    expect(isAuthorizedProjectProxyIpcSender({ ...common, frame: trustedTop })).toBe(false);
    expect(
      isAuthorizedProjectProxyIpcSender({
        ...common,
        callerWindow: navigator,
        frame: trustedTop,
        requestedProjectPath: '',
      }),
    ).toBe(false);
  });
});

describe('attachNavigatorTrustBoundary', () => {
  function makeHarness() {
    let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
    let navigateHandler: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    const openExternal = mock(async (_url: string) => {});
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
    };
    attachNavigatorTrustBoundary(webContents, DEV_TARGET, { openExternal, log });
    return {
      open: (url: string) => openHandler?.({ url }),
      navigate: (url: string) => {
        const preventDefault = mock(() => {});
        navigateHandler?.({ preventDefault }, url);
        return preventDefault;
      },
      openExternal,
      log,
      webContents,
    };
  }

  test('denies every child window and delegates only allowlisted external URLs', () => {
    const harness = makeHarness();
    expect(harness.open('http://localhost:5173/#/navigator')).toEqual({ action: 'deny' });
    expect(harness.openExternal).not.toHaveBeenCalled();

    expect(harness.open('https://docs.openknowledge.dev/')).toEqual({ action: 'deny' });
    expect(harness.openExternal).toHaveBeenCalledTimes(1);
    expect(harness.openExternal).toHaveBeenLastCalledWith('https://docs.openknowledge.dev/');

    expect(harness.open('javascript:alert(document.domain)')).toEqual({ action: 'deny' });
    expect(harness.openExternal).toHaveBeenCalledTimes(1);
    expect(harness.log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'blocked outbound URL',
        data: expect.objectContaining({ source: 'new-window' }),
      }),
    );
  });

  test('allows trusted dev navigation but prevents and delegates cross-origin navigation', () => {
    const harness = makeHarness();
    const trustedPrevent = harness.navigate('http://localhost:5173/@vite/client?t=2');
    expect(trustedPrevent).not.toHaveBeenCalled();
    expect(harness.openExternal).not.toHaveBeenCalled();

    const externalPrevent = harness.navigate('https://example.com/guide');
    expect(externalPrevent).toHaveBeenCalledTimes(1);
    expect(harness.openExternal).toHaveBeenCalledWith('https://example.com/guide');

    const blockedPrevent = harness.navigate('file:///etc/passwd');
    expect(blockedPrevent).toHaveBeenCalledTimes(1);
    expect(harness.openExternal).toHaveBeenCalledTimes(1);
  });

  test('attaches both defenses synchronously', () => {
    const harness = makeHarness();
    expect(harness.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    expect(harness.webContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));
  });
});
