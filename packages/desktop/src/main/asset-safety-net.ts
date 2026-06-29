
import { ASSET_EXTENSIONS } from '@inkeep/open-knowledge-core';
import type { AssetOpenResult } from './asset-allowlist.ts';

interface WebContentsLike {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void;
  on(
    event: 'will-navigate',
    handler: (event: { preventDefault: () => void }, url: string) => void,
  ): void;
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

export function matchAssetUrl(url: string, editorOrigin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const origin = parsed.origin;
  if (origin !== editorOrigin) return null;

  const raw = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!path) return null;

  const lastSegment = path.split('/').pop() ?? '';
  const extMatch = lastSegment.match(/\.([a-z0-9]+)$/i);
  if (!extMatch) return null;
  const ext = (extMatch[1] ?? '').toLowerCase();
  if (ext === 'html' || ext === 'htm') return null;
  if (!ASSET_EXTENSIONS.has(ext)) return null;

  return path;
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
      void deps.openAsset(relPath).then((result) => {
        if (!result.ok) {
          log({
            level: 'warn',
            message: 'openAsset refused from setWindowOpenHandler',
            data: { relPath, reason: result.reason },
          });
        }
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
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (
      parsed.origin === deps.editorOrigin ||
      parsed.origin === safeOrigin(webContents.getURL?.())
    ) {
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
