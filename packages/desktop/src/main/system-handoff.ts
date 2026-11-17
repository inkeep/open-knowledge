import type { Session } from 'electron';
import type { DesktopLogger } from './desktop-logger.ts';
import { checkOutboundUrl } from './shell-allowlist.ts';

type HandoffLog = Pick<DesktopLogger, 'warn'>;

type Permission = Parameters<NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>>[1];

const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

export function isWebAddress(url: string): boolean {
  const parsed = URL.parse(url);
  return parsed !== null && WEB_PROTOCOLS.has(parsed.protocol);
}

interface HandoffRequestDetails {
  readonly isMainFrame: boolean;
  readonly requestingUrl: string;
  readonly externalURL?: string;
}

export type PermissionRequestHandler = (
  webContents: unknown,
  permission: Permission,
  callback: (granted: boolean) => void,
  details: HandoffRequestDetails,
) => void;

type OpenExternalRefusal =
  | 'requester-not-app-page-main-frame'
  | 'no-address'
  | 'address-not-listed';

export function createPermissionRequestHandler(
  appPageAddress: string,
  log: HandoffLog,
): PermissionRequestHandler {
  const appPage = new URL(appPageAddress);
  const isAppPageAddress = (address: string): boolean => {
    const parsed = URL.parse(address);
    return parsed !== null && parsed.protocol === appPage.protocol && parsed.host === appPage.host;
  };
  const refusalOf = (details: HandoffRequestDetails): OpenExternalRefusal | null => {
    if (!details.isMainFrame || !isAppPageAddress(details.requestingUrl)) {
      return 'requester-not-app-page-main-frame';
    }
    if (details.externalURL === undefined) return 'no-address';
    return checkOutboundUrl(details.externalURL).ok ? null : 'address-not-listed';
  };
  return (_webContents, permission, callback, details) => {
    if (permission !== 'openExternal') {
      callback(true);
      return;
    }
    const refusedBecause = refusalOf(details);
    if (refusedBecause !== null) {
      log.warn(
        {
          request: permission,
          requestingUrl: details.requestingUrl,
          isMainFrame: details.isMainFrame,
          address: details.externalURL,
          refusedBecause,
        },
        'refused an openExternal permission request',
      );
    }
    callback(refusedBecause === null);
  };
}

type WindowOpenResponse = { action: 'allow' | 'deny' };

export function webAddressesOnly(
  details: { readonly url: string },
  log: HandoffLog,
): WindowOpenResponse {
  if (isWebAddress(details.url)) return { action: 'allow' };
  log.warn(
    { request: 'new-window', address: details.url, refusedBecause: 'not-a-web-address' },
    'refused a new-window request to a non-web address',
  );
  return { action: 'deny' };
}

interface HandoffWebContents {
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenResponse): void;
  readonly session: {
    setPermissionRequestHandler(handler: PermissionRequestHandler): void;
  };
}

export function applySystemHandoffRules(
  contents: HandoffWebContents,
  permissionHandler: PermissionRequestHandler,
  log: HandoffLog,
): void {
  contents.session.setPermissionRequestHandler(permissionHandler);
  contents.setWindowOpenHandler((details) => webAddressesOnly(details, log));
}
