/**
 * Navigation trust boundary for SSH-backed editor windows.
 *
 * A remote project's API is intentionally reachable through a desktop-owned
 * loopback tunnel, but it is not a trusted renderer. In particular, the
 * remote server can serve project-authored HTML. If that HTML replaces the
 * editor's top-level document it inherits the BrowserWindow preload bridge,
 * turning remote project content into a privileged IPC caller.
 *
 * Keep the WebContents pinned to the local app renderer and deny every child
 * window. This module is Electron-free so the URL policy can be tested without
 * constructing a BrowserWindow.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface RemoteEditorRendererTarget {
  /** Path passed to BrowserWindow.loadFile in packaged/production builds. */
  readonly rendererEntryPath: string;
  /** URL passed to BrowserWindow.loadURL while the Vite dev server is active. */
  readonly rendererDevUrl?: string | null;
}

interface RemoteEditorWebContentsLike {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  on(
    event: 'will-navigate',
    handler: (event: { preventDefault(): void }, url: string) => void,
  ): void;
  executeJavaScript(code: string): Promise<unknown>;
}

interface RemoteEditorTrustBoundaryDeps {
  /** The tunneled project server origin. It must never become top-level. */
  readonly apiOrigin: string;
  /** Delegate a narrowly allowed public web/mail URL to the OS. */
  readonly openExternal: (url: string) => Promise<void>;
  readonly log?: (event: {
    readonly message: string;
    readonly data: Readonly<Record<string, unknown>>;
  }) => void;
}

const EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

const DEFAULT_LOG: Required<RemoteEditorTrustBoundaryDeps>['log'] = (event) => {
  console.warn(`[remote-editor-trust-boundary] ${event.message}`, event.data);
};

/**
 * Return true only for a URL owned by the configured local app renderer.
 *
 * Dev trusts the configured Vite HTTP(S) origin so HMR and module loads work.
 * Packaged builds trust only the exact file loaded with loadFile; comparing
 * file origins is unsafe because file/data/blob URLs all serialize to `null`.
 */
export function isTrustedRemoteEditorUrl(
  url: unknown,
  target: RemoteEditorRendererTarget,
): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;

  let candidate: URL;
  try {
    candidate = new URL(url);
  } catch {
    return false;
  }

  if (target.rendererDevUrl) {
    let expected: URL;
    try {
      expected = new URL(target.rendererDevUrl);
    } catch {
      return false;
    }
    if (expected.protocol !== 'http:' && expected.protocol !== 'https:') return false;
    return candidate.protocol === expected.protocol && candidate.origin === expected.origin;
  }

  const expected = pathToFileURL(resolve(target.rendererEntryPath));
  if (candidate.protocol !== 'file:') return false;
  candidate.hash = '';
  candidate.search = '';
  return candidate.href === expected.href;
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  const unbracketed = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  // A terminal dot only marks an absolute DNS name; `localhost.` still
  // resolves to the same loopback host as `localhost`.
  return unbracketed.endsWith('.') ? unbracketed.slice(0, -1) : unbracketed;
}

function isIpv4MappedLocalHostname(hostname: string): boolean {
  // URL parsing canonicalizes IPv4-mapped IPv6 literals to
  // `::ffff:<high-word>:<low-word>` before this helper sees them.
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  const highWord = match?.[1];
  const lowWord = match?.[2];
  if (highWord === undefined || lowWord === undefined) return false;

  const high = Number.parseInt(highWord, 16);
  const low = Number.parseInt(lowWord, 16);
  return (high & 0xff00) === 0x7f00 || (high === 0 && low === 0);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (normalized === '::1' || normalized === '0.0.0.0' || normalized === '::') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(normalized) || isIpv4MappedLocalHostname(normalized);
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Remote project API URLs are blocked rather than delegated to the OS. Treat
 * loopback aliases on the tunnel port as equivalent to the announced origin.
 */
export function isRemoteProjectApiUrl(url: unknown, apiOrigin: string): boolean {
  const candidate = parseUrl(url);
  const expected = parseUrl(apiOrigin);
  if (!candidate || !expected) return false;
  if (candidate.origin === expected.origin) return true;
  return (
    candidate.protocol === expected.protocol &&
    candidate.port === expected.port &&
    isLoopbackHostname(candidate.hostname) &&
    isLoopbackHostname(expected.hostname)
  );
}

/**
 * Only ordinary public web/mail destinations are safe to delegate from an
 * untrusted-project boundary. Custom schemes can launch privileged local apps,
 * and loopback URLs can target the SSH tunnel or unrelated local services.
 */
export function isSafeRemoteExternalUrl(url: unknown): url is string {
  const parsed = parseUrl(url);
  if (!parsed || !EXTERNAL_SCHEMES.has(parsed.protocol)) return false;
  if (parsed.protocol !== 'mailto:' && isLoopbackHostname(parsed.hostname)) return false;
  return true;
}

function navigateToHashScript(hash: string): string {
  return `window.location.hash = ${JSON.stringify(hash)};`;
}

function trustedInAppHash(url: string, target: RemoteEditorRendererTarget): string | null {
  if (!isTrustedRemoteEditorUrl(url, target)) return null;
  const parsed = parseUrl(url);
  return parsed?.hash.startsWith('#/') ? parsed.hash : null;
}

function delegateExternal(
  url: string,
  source: 'new-window' | 'navigation',
  deps: RemoteEditorTrustBoundaryDeps,
): void {
  const log = deps.log ?? DEFAULT_LOG;
  if (!isSafeRemoteExternalUrl(url)) {
    log({ message: 'blocked outbound URL', data: { source, url } });
    return;
  }

  void deps.openExternal(url).catch((err: unknown) => {
    log({
      message: 'openExternal failed',
      data: {
        source,
        url,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  });
}

/**
 * Pin an SSH-backed editor WebContents to the local renderer.
 *
 * This must be installed immediately after BrowserWindow construction and
 * before loadURL/loadFile. The remote API origin is always denied, including
 * project HTML and loopback aliases. External public web/mail links may leave
 * through the OS; custom, local, opaque, and malformed URLs are dropped.
 */
export function attachRemoteEditorTrustBoundary(
  webContents: RemoteEditorWebContentsLike,
  target: RemoteEditorRendererTarget,
  deps: RemoteEditorTrustBoundaryDeps,
): void {
  if (!parseUrl(deps.apiOrigin)) {
    throw new Error('Cannot attach remote editor trust boundary: invalid API origin.');
  }
  const log = deps.log ?? DEFAULT_LOG;

  webContents.setWindowOpenHandler(({ url }) => {
    const inAppHash = trustedInAppHash(url, target);
    if (inAppHash !== null) {
      void webContents.executeJavaScript(navigateToHashScript(inAppHash)).catch((err: unknown) => {
        log({
          message: 'in-app navigation failed',
          data: {
            hash: inAppHash,
            err: err instanceof Error ? err.message : String(err),
          },
        });
      });
      return { action: 'deny' };
    }

    if (isRemoteProjectApiUrl(url, deps.apiOrigin)) {
      log({ message: 'blocked remote API child window', data: { url } });
      return { action: 'deny' };
    }
    // Even a trusted renderer URL must not create a second privileged window.
    if (!isTrustedRemoteEditorUrl(url, target)) delegateExternal(url, 'new-window', deps);
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    // Check the API origin first so a configuration collision fails closed.
    if (!isRemoteProjectApiUrl(url, deps.apiOrigin) && isTrustedRemoteEditorUrl(url, target)) {
      return;
    }

    event.preventDefault();
    if (isRemoteProjectApiUrl(url, deps.apiOrigin)) {
      log({ message: 'blocked remote API top-level navigation', data: { url } });
      return;
    }
    delegateExternal(url, 'navigation', deps);
  });
}
