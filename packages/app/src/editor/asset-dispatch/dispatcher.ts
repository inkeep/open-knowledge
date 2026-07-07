/**
 * `dispatchAssetClick` — renderer-side routing for OS-delegating an asset.
 * Bare clicks on asset link chips navigate to the in-app asset preview
 * instead (see `activateAssetLink` in `internal-link-helpers.ts`); this
 * dispatcher fires on the OS-delegation paths: Cmd/Ctrl/middle-click on a
 * link chip (`internal-link.ts` + `wiki-link-embed.ts` handlePrimary, via
 * `activateAssetLink`) and the asset preview's "Open file" button
 * (`AssetPreview.tsx`).
 *
 * Ordering:
 *   1. Cmd/Ctrl+click → `forceOsDelegation: true` → skip the registry
 *   2. Registry lookup on `ctx.ext` → viewer.render(ctx) if found
 *   3. Electron fallback → `window.okDesktop.shell.openAsset(projectRelPath)`
 *   4. Web fallback → `openHashHrefInNewTab(url)`
 *
 * Deps injected for testability (`registry`, `desktopBridge`, `openUrl`) —
 * prod callers pass none and get the singleton registry + the real
 * `window.okDesktop` + the real tab-opener.
 *
 * No refs-level knowledge of executable-blocklist or path-escape — those
 * checks live in the main-process handler (`openAssetSafely`).
 * The dispatcher's job is routing; the enforcement fires at the IPC boundary
 * where `isPathWithinProject` + `realpath` run under main-process trust.
 */

import { type AssetViewerRegistry, assetViewerRegistry } from './registry.ts';
import type { AssetClickContext } from './types.ts';

/**
 * Optional overrides for tests + alternate host contexts. Production callers
 * pass nothing — defaults read from the module singletons / global window.
 */
interface DispatchAssetClickDeps {
  readonly registry?: AssetViewerRegistry;
  /**
   * Renderer → main bridge. When `undefined`, the Electron branch is skipped
   * and the web fallback fires. Defaults to `globalThis.window?.okDesktop`.
   */
  readonly desktopBridge?: typeof window.okDesktop;
  /**
   * Web fallback — invoked when no registry hit AND no Electron bridge.
   * Opens the URL in a new tab via `window.open(url, '_blank',
   * 'noopener,noreferrer')`. The URL is guaranteed project-relative or
   * absolute-same-origin at call time (the classifier rejects external
   * URLs before `dispatchAssetClick` is invoked), so no scheme-allowlist
   * gate is needed — a scheme gate (like `openHashHrefInNewTab`'s
   * `isSafeNavigationUrl`) would reject bare filenames like `meeting.pdf`.
   */
  readonly openUrl?: (url: string) => void;
}

function defaultOpenAssetTab(url: string): void {
  globalThis.window?.open(url, '_blank', 'noopener,noreferrer');
}

export async function dispatchAssetClick(
  ctx: AssetClickContext,
  deps: DispatchAssetClickDeps = {},
): Promise<void> {
  const registry = deps.registry ?? assetViewerRegistry;
  // Respect explicit `desktopBridge: undefined` passed by tests to force the
  // web-fallback branch — only fall back to globalThis when the key is absent
  // from `deps` entirely.
  const desktopBridge = 'desktopBridge' in deps ? deps.desktopBridge : globalThis.window?.okDesktop;
  const openUrl = deps.openUrl ?? defaultOpenAssetTab;

  // 1. Cmd/Ctrl+click (or middle-click) always skips the registry.
  if (!ctx.forceOsDelegation) {
    const lookup = registry.lookup(ctx.ext);
    if (lookup.ok) {
      lookup.viewer.render(ctx);
      return;
    }
  }

  // 2. Electron fallback — OS-delegate via IPC. Main-process handler enforces
  //    containment (isPathWithinProject + realpath) and the executable
  //    blocklist. Refusal is logged; the dispatcher does not fall through
  //    to web because in Electron a browser-new-tab would still replace
  //    the webContents.
  if (desktopBridge) {
    const result = await desktopBridge.shell.openAsset(ctx.projectRelPath);
    if (!result.ok) {
      // `extension-blocked` means the file exists but OK refuses to hand a
      // scripted/executable type (html, svg, ...) to `shell.openPath` (RCE
      // defense). The file is real — reveal it in the native file manager so
      // the user can open it themselves, rather than failing silently.
      if (result.reason === 'extension-blocked') {
        const revealed = await desktopBridge.shell.revealAsset(ctx.projectRelPath);
        if (!revealed.ok) {
          console.warn('[asset-dispatch] revealAsset failed:', revealed.reason, {
            projectRelPath: ctx.projectRelPath,
            ext: ctx.ext,
          });
        }
        return;
      }
      console.warn('[asset-dispatch] openAsset refused:', result.reason, {
        projectRelPath: ctx.projectRelPath,
        ext: ctx.ext,
      });
    }
    return;
  }

  // 3. Web fallback — new tab via `window.open(ctx.url, '_blank',
  //    'noopener,noreferrer')`. The URL is the href the classifier emitted
  //    (project-relative or same-origin absolute) — browser resolves it
  //    against the current page. No scheme gate: the classifier already
  //    rejected authored external URLs before reaching the dispatcher,
  //    and project-relative asset URLs (`meeting.pdf`, `./photo.png`)
  //    would fail a scheme-allowlist by construction.
  openUrl(ctx.url);
}
