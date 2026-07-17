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
  showOkFolders: 'Show .ok folders',
  showOnlyMarkdownFiles: 'Show only markdown files',
  showSkillsSection: 'Show skills section',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  // Move to Trash keeps "Trash" capitalized — the macOS destination proper noun,
  // same treatment as Finder / Terminal above.
  moveToTrash: 'Move to Trash',
  // Copy path is nested in the native menu (Copy path ▸ Full path / Relative
  // path); the Cmd+K palette flattens it, so these two are palette-side labels
  // that the parity test still keeps present in the compiled catalog.
  copyFullPath: 'Copy full path',
  copyRelativePath: 'Copy relative path',
  // Backfilled Cmd+K commands whose native-menu counterparts are static-label
  // items (not state-aware Show/Hide toggles). Shared so both surfaces read
  // identically; the native menu appends the … ellipsis at its call site.
  checkForUpdates: 'Check for updates',
  setUpIntegrations: 'Set up OpenKnowledge integrations',
  closeTab: 'Close tab',
  newWorktree: 'New worktree',
  switchWorktree: 'Switch worktree',
  newTerminal: 'New Terminal',
  killTerminal: 'Kill Terminal',
  checkSpelling: 'Check spelling while typing',
  openOnGithub: 'OpenKnowledge on GitHub',
} as const;

export type MenuLabelKey = keyof typeof MENU_LABELS;

/**
 * Canonical repository URL shared by the native Help menu and the Cmd+K
 * palette's "OpenKnowledge on GitHub" command, so the two surfaces cannot
 * drift (the parity ratchets check labels, not URLs).
 */
export const OPEN_KNOWLEDGE_GITHUB_URL = 'https://github.com/inkeep/open-knowledge';
