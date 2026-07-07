/**
 * Native right-click context menu for on-disk references. Built from
 * `Menu.buildFromTemplate` in main — main observes the click directly
 * so the gesture is attested without IPC gesture forwarding.
 *
 * Entries:
 *   - Reveal in Finder / Show in Explorer / Open in file manager
 *     (platform-label + `shell.showItemInFolder` via `revealAssetSafely`)
 *   - Open in default app (`shell.openPath` via `openAssetSafely`)
 *   - Copy link (main-process `clipboard.writeText(projectRelPath)`)
 *
 * Works uniformly for `asset` | `wiki-link` | `image` kinds — the UX is
 * "right-click any on-disk reference to reach OS actions." Asset + image
 * share the same action set; `wiki-link` (doc-to-doc [[foo]]) points at
 * the target markdown file and gets the same Reveal + Open + Copy.
 *
 * Pure-ish: `buildAssetMenuTemplate` takes a `kind` + `actions` and
 * returns a `MenuItemConstructorOptions[]`. Tests exercise the template
 * shape + callback dispatch without mounting Electron's Menu/Tray.
 */

import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';

type AssetMenuKind = 'asset' | 'wiki-link' | 'image';

interface AssetMenuActions {
  /** Fires on "Reveal in Finder" / "Show in Explorer" / "Open in file manager". */
  readonly reveal: () => void | Promise<void>;
  /** Fires on "Open in default app". */
  readonly openInDefault: () => void | Promise<void>;
  /** Fires on "Copy link". Writes the project-rel path to clipboard. */
  readonly copyLink: () => void | Promise<void>;
}

/**
 * Platform-label for the Reveal-in-file-manager entry. macOS users expect
 * "Reveal in Finder" (the canonical OSX phrase used by VSCode, Xcode,
 * Finder itself); Windows expects "Show in Explorer"; Linux's generic
 * "Open in file manager" matches GNOME / KDE convention without pinning
 * a specific desktop.
 */
export function revealMenuLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Show in Explorer';
  return 'Open in file manager';
}

interface BuildAssetMenuTemplateParams {
  readonly kind: AssetMenuKind;
  readonly platform: NodeJS.Platform;
  readonly actions: AssetMenuActions;
}

export function buildAssetMenuTemplate(
  params: BuildAssetMenuTemplateParams,
): MenuItemConstructorOptions[] {
  const { platform, actions } = params;
  return [
    {
      label: revealMenuLabel(platform),
      click: () => {
        void actions.reveal();
      },
    },
    {
      label: 'Open in default app',
      click: () => {
        void actions.openInDefault();
      },
    },
    { type: 'separator' },
    {
      label: 'Copy link',
      click: () => {
        void actions.copyLink();
      },
    },
  ];
}

interface PopAssetMenuDeps {
  /** Electron `Menu` ctor — injected for testability. */
  readonly Menu: Pick<typeof Menu, 'buildFromTemplate'>;
  /** Window to pop the menu over (the one whose webContents fired the event). */
  readonly window: BrowserWindow;
}

/**
 * Build the template + pop the native menu on the given window. Thin
 * orchestration so the pure template builder stays test-easy and the
 * popup call lives in one place.
 */
export function popAssetMenu(deps: PopAssetMenuDeps, params: BuildAssetMenuTemplateParams): void {
  // A right-click can race window close (⌘W): `popup` on a destroyed window
  // pops over an arbitrary surviving window, or throws when none remain —
  // fatal in main, which deliberately has no userland uncaughtException
  // handler (see process-safety-net.ts). Dropping the menu is correct for a
  // gesture on a window that no longer exists. Mirrors popSpellcheckMenu.
  if (deps.window.isDestroyed()) return;
  const template = buildAssetMenuTemplate(params);
  deps.Menu.buildFromTemplate(template).popup({ window: deps.window });
}
