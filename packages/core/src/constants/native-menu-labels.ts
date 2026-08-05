/**
 * English source strings for native-menu text that has no `MENU_LABELS` entry:
 * Electron's own `role:` labels, the top-level menu titles, the recents
 * submenus, and the two context menus (spellcheck, on-disk reference).
 *
 * Why a second constant beside `MENU_LABELS`: that one holds the labels the
 * shared command registry points its `labelKey` at, and every value there is
 * also rendered by the Cmd+K palette. Nothing here has a palette counterpart —
 * these are menu-bar structure and OS-supplied item names. Splitting keeps the
 * registry's label contract from absorbing strings no command owns.
 *
 * The role labels matter more than they look. Electron hardcodes them as
 * English literals in `lib/browser/api/menu-item-roles.ts` with no OS lookup and
 * no locale variation, so a role item left without an explicit `label` renders
 * English inside an otherwise translated menu bar. Every string below is
 * byte-identical to Electron 41's own, so an English build reads exactly as it
 * did before the labels became explicit.
 *
 * Three roles vary by platform, matching Electron: `about` reads "About" on
 * Linux and "About <app>" elsewhere; `quit` reads "Exit" on Windows, "Quit
 * <app>" on macOS, and "Quit" elsewhere; `close` reads "Close Window" on macOS
 * and "Close" elsewhere.
 *
 * The main process resolves each of these through the compiled renderer catalog
 * (hashing the English source to its message id), so the strings must also
 * reach that catalog — `packages/app/src/lib/native-menu-catalog.ts` mirrors
 * every key as a Lingui `msg` descriptor and a parity test asserts the two
 * agree. Same arrangement, and same reason, as `MENU_LABELS`: the macro needs a
 * string literal at the call site, so the renderer cannot import these.
 */
export const NATIVE_MENU_LABELS = {
  // Electron role labels.
  roleAbout: 'About {appName}',
  roleAboutGeneric: 'About',
  roleServices: 'Services',
  roleHide: 'Hide {appName}',
  roleHideOthers: 'Hide Others',
  roleUnhide: 'Show All',
  roleQuit: 'Quit {appName}',
  roleQuitGeneric: 'Quit',
  roleExit: 'Exit',
  roleUndo: 'Undo',
  roleRedo: 'Redo',
  roleCut: 'Cut',
  roleCopy: 'Copy',
  rolePaste: 'Paste',
  roleSelectAll: 'Select All',
  roleReload: 'Reload',
  roleForceReload: 'Force Reload',
  roleToggleDevTools: 'Toggle Developer Tools',
  roleResetZoom: 'Actual Size',
  roleZoomIn: 'Zoom In',
  roleZoomOut: 'Zoom Out',
  roleToggleFullScreen: 'Toggle Full Screen',
  roleMinimize: 'Minimize',
  roleZoom: 'Zoom',
  roleFront: 'Bring All to Front',
  roleCloseWindow: 'Close Window',
  roleClose: 'Close',

  // Top-level menu titles. The macOS App menu's own title is `app.name`, a
  // proper noun, so it has no entry here.
  menuFile: 'File',
  menuEdit: 'Edit',
  menuView: 'View',
  menuTerminal: 'Terminal',
  menuWindow: 'Window',
  menuHelp: 'Help',

  // File → Recent project / Recent files submenus.
  recentProject: 'Recent project',
  recentFiles: 'Recent files',
  noRecentProjects: 'No recent projects',
  noRecentFiles: 'No recent files',
  clearMenu: 'Clear menu',

  // Editable-content context menu (spellcheck-menu.ts).
  addToDictionary: 'Add to Dictionary',
  disableSpellCheck: 'Disable Spell Check',
  enableSpellCheck: 'Enable Spell Check',
  lookUpWord: 'Look Up "{word}"',
  searchWithGoogle: 'Search with Google',
  viewInSourceMarkdown: 'View in Source Markdown',

  // On-disk-reference context menu (asset-menu.ts). "Reveal in Finder" is the
  // macOS wording and already lives in `MENU_LABELS`, which the File menu also
  // renders; only the two non-macOS wordings are new here.
  showInExplorer: 'Show in Explorer',
  openInFileManager: 'Open in file manager',
  openInDefaultApp: 'Open in default app',
  copyLink: 'Copy link',
} as const satisfies Record<string, string>;

export type NativeMenuLabelKey = keyof typeof NATIVE_MENU_LABELS;
