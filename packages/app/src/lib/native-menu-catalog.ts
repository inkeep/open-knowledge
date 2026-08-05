/**
 * Renderer-side mirror of `NATIVE_MENU_LABELS`, declared as Lingui `msg`
 * descriptors so the native menu's strings reach the compiled catalog.
 *
 * Nothing in the renderer renders these. They exist because the Electron main
 * process resolves its menu labels through the SAME compiled catalog the
 * renderer loads — it hashes an English source string to its message id — and a
 * string only enters that catalog if the extractor found it inside a macro.
 * Extraction walks `packages/app/src`, so a main-process-only string has to be
 * declared here or the lookup returns English in every language.
 *
 * The macro needs a string literal at the call site, so this cannot import the
 * constants it mirrors. `native-menu-catalog.test.ts` asserts every descriptor
 * resolves to its `NATIVE_MENU_LABELS` value, which is what keeps the two
 * copies honest — the same arrangement `menu-label-parity.test.ts` already
 * enforces for `MENU_LABELS` and the Cmd+K palette.
 */

import type { NativeMenuLabelKey } from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export const NATIVE_MENU_MESSAGES = {
  roleAbout: msg`About {appName}`,
  roleAboutGeneric: msg`About`,
  roleServices: msg`Services`,
  roleHide: msg`Hide {appName}`,
  roleHideOthers: msg`Hide Others`,
  roleUnhide: msg`Show All`,
  roleQuit: msg`Quit {appName}`,
  roleQuitGeneric: msg`Quit`,
  roleExit: msg`Exit`,
  roleUndo: msg`Undo`,
  roleRedo: msg`Redo`,
  roleCut: msg`Cut`,
  roleCopy: msg`Copy`,
  rolePaste: msg`Paste`,
  roleSelectAll: msg`Select All`,
  roleReload: msg`Reload`,
  roleForceReload: msg`Force Reload`,
  roleToggleDevTools: msg`Toggle Developer Tools`,
  roleResetZoom: msg`Actual Size`,
  roleZoomIn: msg`Zoom In`,
  roleZoomOut: msg`Zoom Out`,
  roleToggleFullScreen: msg`Toggle Full Screen`,
  roleMinimize: msg`Minimize`,
  roleZoom: msg`Zoom`,
  roleFront: msg`Bring All to Front`,
  roleCloseWindow: msg`Close Window`,
  roleClose: msg`Close`,

  menuFile: msg`File`,
  menuEdit: msg`Edit`,
  menuView: msg`View`,
  menuTerminal: msg`Terminal`,
  menuWindow: msg`Window`,
  menuHelp: msg`Help`,

  recentProject: msg`Recent project`,
  recentFiles: msg`Recent files`,
  noRecentProjects: msg`No recent projects`,
  noRecentFiles: msg`No recent files`,
  clearMenu: msg`Clear menu`,

  addToDictionary: msg`Add to Dictionary`,
  disableSpellCheck: msg`Disable Spell Check`,
  enableSpellCheck: msg`Enable Spell Check`,
  lookUpWord: msg`Look Up "{word}"`,
  searchWithGoogle: msg`Search with Google`,
  viewInSourceMarkdown: msg`View in Source Markdown`,

  showInExplorer: msg`Show in Explorer`,
  openInFileManager: msg`Open in file manager`,
  openInDefaultApp: msg`Open in default app`,
  copyLink: msg`Copy link`,
} satisfies Record<NativeMenuLabelKey, MessageDescriptor>;

/**
 * The command registry's `menuLabelText` overrides — leaves whose native-menu
 * wording differs from the palette's, so the shared `MENU_LABELS` value the
 * palette renders is not the string the menu shows.
 *
 * Declared here for the same reason as the map above, and kept as a flat list
 * because nothing looks these up by key: the menu resolves them from the
 * registry, and this exists only to put them in the catalog.
 * `native-menu-catalog.test.ts` asserts this list and the registry's own
 * `menuLabelText` values are the same set, so adding one to the registry
 * without a descriptor here fails rather than silently shipping English.
 */
export const MENU_LABEL_TEXT_MESSAGES: readonly MessageDescriptor[] = [
  msg`Install for Claude Chat & Cowork (desktop app)`,
  msg`New Terminal Window`,
  msg`Uninstall OpenKnowledge`,
];
