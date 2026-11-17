import { describe, expect, test, vi } from 'vitest';
import {
  applySystemHandoffRules,
  createPermissionRequestHandler,
  type PermissionRequestHandler,
  webAddressesOnly,
} from '../../src/main/system-handoff.ts';

const PACKAGED_APP_PAGE =
  'file:///Applications/OpenKnowledge.app/Contents/Resources/app/index.html';
const DEV_APP_PAGE = 'http://localhost:5173/';

const LISTED_MAIL_ADDRESS = 'mailto:someone@example.com?subject=hello';
const LISTED_APP_ADDRESS = 'openknowledge://open?project=%2Ftmp%2Fnotes';
const UNLISTED_ADDRESS = 'tel:+15550100';

const silentLog = { warn: () => {} };

function decide(
  handler: PermissionRequestHandler,
  permission: string,
  details: { isMainFrame: boolean; requestingUrl: string; externalURL?: string },
): boolean {
  const callback = vi.fn((_granted: boolean) => {});
  handler({}, permission, callback, details);
  expect(callback).toHaveBeenCalledTimes(1);
  return callback.mock.calls[0]?.[0] ?? false;
}

describe('openExternal requests: only the app page, only addresses on the list', () => {
  const packaged = createPermissionRequestHandler(PACKAGED_APP_PAGE, silentLog);

  test('grants the packaged app page a listed address', () => {
    for (const externalURL of [LISTED_MAIL_ADDRESS, LISTED_APP_ADDRESS]) {
      expect(
        decide(packaged, 'openExternal', {
          isMainFrame: true,
          requestingUrl: `${PACKAGED_APP_PAGE}#/notes/today`,
          externalURL,
        }),
      ).toBe(true);
    }
  });

  test('grants the app page in development a listed address', () => {
    const dev = createPermissionRequestHandler(DEV_APP_PAGE, silentLog);
    expect(
      decide(dev, 'openExternal', {
        isMainFrame: true,
        requestingUrl: 'http://localhost:5173/#/notes/today',
        externalURL: LISTED_MAIL_ADDRESS,
      }),
    ).toBe(true);
  });

  test('refuses a frame inside the page, whatever the address', () => {
    for (const externalURL of [LISTED_MAIL_ADDRESS, LISTED_APP_ADDRESS, UNLISTED_ADDRESS]) {
      expect(
        decide(packaged, 'openExternal', {
          isMainFrame: false,
          requestingUrl: 'https://embed.example/player?id=1',
          externalURL,
        }),
      ).toBe(false);
    }
  });

  test('refuses a frame inside the page even when it is served from the app bundle', () => {
    expect(
      decide(packaged, 'openExternal', {
        isMainFrame: false,
        requestingUrl:
          'file:///Applications/OpenKnowledge.app/Contents/Resources/app/assets/preview-frame.html',
        externalURL: LISTED_MAIL_ADDRESS,
      }),
    ).toBe(false);
  });

  test('refuses the app page an address outside the list', () => {
    expect(
      decide(packaged, 'openExternal', {
        isMainFrame: true,
        requestingUrl: PACKAGED_APP_PAGE,
        externalURL: UNLISTED_ADDRESS,
      }),
    ).toBe(false);
  });

  test('refuses a top-level page that is not the app page', () => {
    for (const requestingUrl of ['http://localhost:3030/?embedded=true', 'https://example.com/']) {
      expect(
        decide(packaged, 'openExternal', {
          isMainFrame: true,
          requestingUrl,
          externalURL: LISTED_MAIL_ADDRESS,
        }),
      ).toBe(false);
    }
    const dev = createPermissionRequestHandler(DEV_APP_PAGE, silentLog);
    expect(
      decide(dev, 'openExternal', {
        isMainFrame: true,
        requestingUrl: 'http://localhost:3030/',
        externalURL: LISTED_MAIL_ADDRESS,
      }),
    ).toBe(false);
  });

  test('refuses a request that names no address', () => {
    expect(
      decide(packaged, 'openExternal', { isMainFrame: true, requestingUrl: PACKAGED_APP_PAGE }),
    ).toBe(false);
  });

  test('keeps granting every other permission, from any frame', () => {
    for (const permission of [
      'media',
      'notifications',
      'fullscreen',
      'clipboard-sanitized-write',
    ]) {
      expect(
        decide(packaged, permission, {
          isMainFrame: false,
          requestingUrl: 'https://embed.example/player?id=1',
        }),
      ).toBe(true);
    }
  });
});

describe('new-window requests in a window without its own handler: web addresses only', () => {
  test('keeps today’s response for a web address', () => {
    expect(webAddressesOnly({ url: 'https://example.com/docs' }, silentLog)).toEqual({
      action: 'allow',
    });
    expect(webAddressesOnly({ url: 'http://localhost:5173/' }, silentLog)).toEqual({
      action: 'allow',
    });
  });

  test('refuses any other address', () => {
    for (const url of [LISTED_MAIL_ADDRESS, LISTED_APP_ADDRESS, UNLISTED_ADDRESS, 'not a url']) {
      expect(webAddressesOnly({ url }, silentLog)).toEqual({ action: 'deny' });
    }
  });
});

describe('applySystemHandoffRules', () => {
  test('installs the permission rule on the window’s session and the web-only new-window rule on the window', () => {
    const permissionHandler = createPermissionRequestHandler(PACKAGED_APP_PAGE, silentLog);
    const installed: {
      permission?: PermissionRequestHandler;
      windowOpen?: (details: { url: string }) => { action: 'allow' | 'deny' };
    } = {};
    const contents = {
      session: {
        setPermissionRequestHandler(handler: PermissionRequestHandler) {
          installed.permission = handler;
        },
      },
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }) {
        installed.windowOpen = handler;
      },
    };

    applySystemHandoffRules(contents, permissionHandler, silentLog);

    expect(installed.permission).toBe(permissionHandler);
    expect(installed.windowOpen?.({ url: LISTED_MAIL_ADDRESS })).toEqual({ action: 'deny' });
    expect(installed.windowOpen?.({ url: 'https://example.com/' })).toEqual({ action: 'allow' });
  });
});
