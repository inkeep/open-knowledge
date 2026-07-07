/**
 * Canonical sentence-case labels for file/tree actions that appear in BOTH the
 * native Electron menu bar (`packages/desktop/src/main/menu.ts`) and the in-app
 * renderer menus (`FileTree.tsx` / `FileSidebar.tsx`).
 *
 * Why a shared constant: the same action surfaces twice and the two copies
 * must read identically. The native menu has no i18n runtime, so it imports
 * these strings directly. The renderer wraps the SAME strings in Lingui
 * `<Trans>` / t`` macros — those macros require a string literal at the call
 * site, so the renderer can't import these constants — but a parity test
 * (`packages/app/src/lib/menu-label-parity.test.ts`) asserts every value here
 * is present in the renderer's compiled catalog, keeping both surfaces in
 * lockstep.
 *
 * Casing follows the app's sentence-case convention
 * (`packages/app/scripts/audit-strings/check-casing.ts`). Proper nouns keep
 * their capitals (Finder, Terminal, AI). Native menu items that open a new
 * surface append the platform ellipsis (…) per the Apple HIG — that suffix is
 * native-only and is added at the menu.ts call site, not stored here (same
 * split as `SWITCH_PROJECT_LABEL_WITH_ELLIPSIS` in the desktop package).
 */
export const MENU_LABELS = {
  newFile: 'New file',
  newFolder: 'New folder',
  newFromTemplate: 'New from template',
  newProject: 'New project',
  openFolder: 'Open folder',
  duplicate: 'Duplicate',
  rename: 'Rename',
  revealInFinder: 'Reveal in Finder',
  openWithAi: 'Open with AI',
  copyPath: 'Copy path',
  fullPath: 'Full path',
  relativePath: 'Relative path',
  showHiddenFiles: 'Show hidden files',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
} as const;

export type MenuLabelKey = keyof typeof MENU_LABELS;
