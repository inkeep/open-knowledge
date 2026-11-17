import { matchAssetUrl } from '@inkeep/open-knowledge-core/utils/asset-href';
import type { AssetOpenResult } from './asset-allowlist.ts';
import { isWebAddress } from './system-handoff.ts';

interface NavigationEventLike {
  preventDefault(): void;
  readonly initiator?: { readonly parent: unknown } | null;
}

interface WebContentsLike {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void;
  on(event: 'will-navigate', handler: (event: NavigationEventLike, url: string) => void): void;
  getURL?(): string;
  executeJavaScript?(code: string): Promise<unknown>;
}

interface AttachAssetSafetyNetDeps {
  readonly openAsset: (relPath: string) => Promise<AssetOpenResult>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly editorOrigin: string;
  readonly log?: (event: {
    level: 'warn' | 'info';
    message: string;
    data: Record<string, unknown>;
  }) => void;
}

const DEFAULT_LOG: Required<AttachAssetSafetyNetDeps>['log'] = (event) => {
  console.warn(`[asset-safety-net] ${event.message}`, event.data);
};

export function matchInAppApiNavigation(
  url: string,
  inAppOrigins: readonly (string | null | undefined)[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!inAppOrigins.includes(parsed.origin)) return false;
  return parsed.pathname === '/api' || parsed.pathname.startsWith('/api/');
}

function safeOrigin(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function matchInAppRoute(url: string, rendererOrigin: string | null): string | null {
  if (!rendererOrigin) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== rendererOrigin) return null;
  return parsed.hash.startsWith('#/') ? parsed.hash : null;
}

function startedByTopLevelFrame(event: NavigationEventLike): boolean {
  return event.initiator != null && event.initiator.parent === null;
}

function navigateToHashScript(hash: string): string {
  return `window.location.hash = ${JSON.stringify(hash)};`;
}

export function attachAssetSafetyNet(
  webContents: WebContentsLike,
  deps: AttachAssetSafetyNetDeps,
): void {
  const log = deps.log ?? DEFAULT_LOG;

  webContents.setWindowOpenHandler((details) => {
    const relPath = matchAssetUrl(details.url, deps.editorOrigin);
    if (relPath !== null) {
      log({
        level: 'warn',
        message: 'refused a new-window request for a project file',
        data: { relPath },
      });
      return { action: 'deny' };
    }
    const inAppHash = matchInAppRoute(details.url, safeOrigin(webContents.getURL?.()));
    if (inAppHash !== null) {
      const nav = webContents.executeJavaScript?.(navigateToHashScript(inAppHash));
      if (nav) {
        void nav.catch((err: unknown) => {
          log({
            level: 'warn',
            message: 'in-app navigation failed from setWindowOpenHandler',
            data: { hash: inAppHash, err: (err as Error).message },
          });
        });
      }
      return { action: 'deny' };
    }
    if (!isWebAddress(details.url)) {
      log({
        level: 'warn',
        message: 'refused a new-window request for a non-web address',
        data: { url: details.url },
      });
      return { action: 'deny' };
    }
    void deps.openExternal(details.url).catch((err: unknown) => {
      log({
        level: 'warn',
        message: 'openExternal refused from setWindowOpenHandler',
        data: { url: details.url, err: (err as Error).message },
      });
    });
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    const relPath = matchAssetUrl(url, deps.editorOrigin);
    if (relPath !== null) {
      event.preventDefault();
      if (!startedByTopLevelFrame(event)) {
        log({
          level: 'warn',
          message: 'refused a project file navigation not started by the page',
          data: { relPath },
        });
        return;
      }
      void deps.openAsset(relPath).then((result) => {
        if (!result.ok) {
          log({
            level: 'warn',
            message: 'openAsset refused from will-navigate',
            data: { relPath, reason: result.reason },
          });
        }
      });
      return;
    }
    const rendererOrigin = safeOrigin(webContents.getURL?.());
    if (matchInAppApiNavigation(url, [deps.editorOrigin, rendererOrigin])) {
      event.preventDefault();
      log({
        level: 'warn',
        message: 'refused top-level navigation into the HTTP API',
        data: { url },
      });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (!isWebAddress(url)) return;
    if (parsed.origin === deps.editorOrigin || parsed.origin === rendererOrigin) {
      return;
    }
    event.preventDefault();
    void deps.openExternal(url).catch((err: unknown) => {
      log({
        level: 'warn',
        message: 'openExternal refused from will-navigate',
        data: { url, err: (err as Error).message },
      });
    });
  });
}
