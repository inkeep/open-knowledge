/**
 * Native right-click context menu for on-disk references. Built from
 * `Menu.buildFromTemplate` in main — main observes the click directly
 * so the gesture is attested without IPC gesture forwarding.
 *
 * Entries:
 *   - Reveal in Finder / Reveal in File Explorer / Open containing folder
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

import { menuLabelForPlatform, NATIVE_MENU_LABELS } from '@inkeep/open-knowledge-core';
import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import { type MenuTranslator, translateEnglish } from './menu-translator.ts';

type AssetMenuKind = 'asset' | 'wiki-link' | 'image';

interface AssetMenuActions {
  /** Fires on "Reveal in Finder" / "Reveal in File Explorer" / "Open containing folder". */
  readonly reveal: () => void | Promise<void>;
  /** Fires on "Open in default app". */
  readonly openInDefault: () => void | Promise<void>;
  /** Fires on "Copy link". Writes the project-rel path to clipboard. */
  readonly copyLink: () => void | Promise<void>;
}

/**
 * Platform-label for the Reveal-in-file-manager entry — the shared
 * `PLATFORM_MENU_LABELS` vocabulary (Reveal in Finder / Reveal in File
 * Explorer / Open containing folder), so this native menu, the app menu bar,
 * and the renderer's context menus all name the action identically.
 */
export function revealMenuLabel(platform: NodeJS.Platform): string {
  return menuLabelForPlatform('revealInFinder', platform);
}

interface BuildAssetMenuTemplateParams {
  readonly kind: AssetMenuKind;
  readonly platform: NodeJS.Platform;
  readonly actions: AssetMenuActions;
  /** Renders each row in the resolved interface language; English when absent. */
  readonly translate?: MenuTranslator;
}

export function buildAssetMenuTemplate(
  params: BuildAssetMenuTemplateParams,
): MenuItemConstructorOptions[] {
  const { platform, actions } = params;
  const translate = params.translate ?? translateEnglish;
  return [
    {
      label: translate(revealMenuLabel(platform)),
      click: () => {
        void actions.reveal();
      },
    },
    {
      label: translate(NATIVE_MENU_LABELS.openInDefaultApp),
      click: () => {
        void actions.openInDefault();
      },
    },
    { type: 'separator' },
    {
      label: translate(NATIVE_MENU_LABELS.copyLink),
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
