/**
 * Trust boundary for the project Navigator.
 *
 * The Navigator has no project context, but its preload exposes privileged
 * launcher operations (including the SSH-machine dispatcher). Keep its main
 * frame pinned to the renderer entry point and refuse child-window creation.
 * This module is Electron-free so the URL and frame checks stay easy to test.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkOutboundUrl } from './shell-allowlist.ts';

export interface NavigatorRendererTarget {
  /** Path passed to BrowserWindow.loadFile in packaged/production builds. */
  readonly rendererEntryPath: string;
  /** URL passed to BrowserWindow.loadURL while the Vite dev server is active. */
  readonly rendererDevUrl?: string | null;
}

interface NavigatorFrameLike {
  readonly url?: unknown;
  readonly parent?: unknown;
}

interface NavigatorWebContentsLike {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  on(
    event: 'will-navigate',
    handler: (event: { preventDefault(): void }, url: string) => void,
  ): void;
}

interface NavigatorTrustBoundaryDeps {
  /**
   * Delegate an allowlisted outbound URL to the OS. Production passes the
   * shared `handleShellOpenExternal` handler; the local scheme check below is
   * an additional guard against an accidentally-unsafe future injection.
   */
  readonly openExternal: (url: string) => Promise<void>;
  readonly log?: (event: {
    readonly message: string;
    readonly data: Readonly<Record<string, unknown>>;
  }) => void;
}

const DEFAULT_LOG: Required<NavigatorTrustBoundaryDeps>['log'] = (event) => {
  console.warn(`[navigator-trust-boundary] ${event.message}`, event.data);
};

/**
 * Return true only for a URL owned by the configured Navigator renderer.
 *
 * Dev uses the Vite origin so HMR/full reloads and Vite-owned module paths
 * keep working. Requiring the same `http(s)` protocol rejects blob/data URLs
 * even when their serialized origin embeds the trusted dev origin.
 *
 * Packaged builds are narrower: only the exact file loaded via `loadFile` is
 * trusted (query/hash are renderer-local state and therefore ignored).
 */
export function isTrustedNavigatorUrl(url: unknown, target: NavigatorRendererTarget): boolean {
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

/**
 * IPC privilege is granted only to the Navigator's trusted top-level frame.
 * Checking `event.sender`/BrowserWindow alone is insufficient: an iframe in
 * that WebContents has the same sender and can invoke preload-exposed IPC.
 */
export function isTrustedNavigatorSenderFrame(
  frame: NavigatorFrameLike | null | undefined,
  target: NavigatorRendererTarget,
): boolean {
  if (!frame || typeof frame !== 'object') return false;
  try {
    // Electron documents `parent === null` as the top-frame test. Avoid
    // comparing `frame.top === frame`: distinct WebFrameMain wrappers can
    // represent the same underlying frame, making object identity unreliable.
    if (frame.parent !== null) return false;
    return isTrustedNavigatorUrl(frame.url, target);
  } catch {
    // A disposed WebFrameMain can throw from accessors during navigation.
    return false;
  }
}

/**
 * Combined main-process authorization gate for Navigator-only IPC handlers.
 * Window identity prevents an editor/terminal caller; the frame check prevents
 * a child frame or navigated-away Navigator from borrowing that identity.
 */
export function isTrustedNavigatorIpcSender(
  callerWindow: unknown,
  navigatorWindow: unknown,
  frame: NavigatorFrameLike | null | undefined,
  target: NavigatorRendererTarget,
): boolean {
  return (
    callerWindow !== null &&
    callerWindow !== undefined &&
    callerWindow === navigatorWindow &&
    isTrustedNavigatorSenderFrame(frame, target)
  );
}

/**
 * Authorize an IPC request that proxies one project's server on behalf of a
 * renderer. The Navigator may target a project selected by the user during a
 * share flow; every other window is restricted to the project bound to its
 * own WindowManager context. Requiring the trusted top-level renderer frame
 * prevents a child frame from borrowing either window's authority.
 */
export function isAuthorizedProjectProxyIpcSender(args: {
  readonly callerWindow: unknown;
  readonly navigatorWindow: unknown;
  readonly frame: NavigatorFrameLike | null | undefined;
  readonly target: NavigatorRendererTarget;
  readonly callerProjectPath: string | null | undefined;
  readonly requestedProjectPath: unknown;
}): boolean {
  if (
    args.callerWindow === null ||
    args.callerWindow === undefined ||
    typeof args.requestedProjectPath !== 'string' ||
    args.requestedProjectPath.length === 0 ||
    !isTrustedNavigatorSenderFrame(args.frame, args.target)
  ) {
    return false;
  }

  if (args.callerWindow === args.navigatorWindow) return true;
  return args.callerProjectPath === args.requestedProjectPath;
}

function delegateExternal(
  url: string,
  source: 'new-window' | 'navigation',
  deps: NavigatorTrustBoundaryDeps,
): void {
  const log = deps.log ?? DEFAULT_LOG;
  const check = checkOutboundUrl(url);
  if (!check.ok) {
    log({
      message: 'blocked outbound URL',
      data: { source, url, reason: check.reason },
    });
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
 * Pin a Navigator WebContents to its configured renderer target.
 *
 * - Child-window requests are always denied. External, allowlisted URLs are
 *   opened by the OS instead of becoming privileged child renderers.
 * - Top-level navigation stays in-process only for the trusted app target.
 *   Cross-origin URLs are prevented and safely delegated to the OS.
 */
export function attachNavigatorTrustBoundary(
  webContents: NavigatorWebContentsLike,
  target: NavigatorRendererTarget,
  deps: NavigatorTrustBoundaryDeps,
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    // A trusted app URL must not create a second privileged Navigator window.
    if (!isTrustedNavigatorUrl(url, target)) delegateExternal(url, 'new-window', deps);
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    if (isTrustedNavigatorUrl(url, target)) return;
    event.preventDefault();
    delegateExternal(url, 'navigation', deps);
  });
}
