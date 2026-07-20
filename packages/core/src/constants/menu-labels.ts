/**
 * Canonical sentence-case labels the shared command registry
 * (`@inkeep/open-knowledge-core/commands`) points its `labelKey` at. Most
 * surface in BOTH the native Electron menu bar (`packages/desktop/src/main/menu.ts`)
 * and the in-app renderer (`FileTree.tsx` / `FileSidebar.tsx` and the Cmd+K
 * palette); a few (e.g. `openGraph`, `initializeStarterPack`, the Show/Hide
 * toggle variants) are palette-only, kept here so the label-parity test guards
 * them and the registry keeps a single label source.
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
 * native-only and is added at the menu render site (the command registry's
 * per-placement `ellipsis` flag), not stored here.
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
  // Additional shared command labels the registry references. Each string is
  // rendered identically by the palette, so the parity test stays green. The
  // native menu appends the … ellipsis at its call site where the command opens
  // a new surface (Switch project…, Settings…).
  switchProject: 'Switch project',
  settings: 'Settings',
  // Open folder's palette row is the descriptive "Open folder on disk"; the
  // native File menu renders the terser "Open folder…" via `openFolder` above.
  openFolderOnDisk: 'Open folder on disk',
  // Palette-only commands (no native-menu leaf); shared here so the label-parity
  // test guards them and the registry keeps a single label source.
  openGraph: 'Open graph',
  initializeStarterPack: 'Initialize starter pack',
  // State-aware Show/Hide toggles — both surfaces render both variants; the
  // native menu is a single row whose label flips on the pushed view-menu-state.
  sidebarShow: 'Show sidebar',
  sidebarHide: 'Hide sidebar',
  docPanelShow: 'Show document panel',
  docPanelHide: 'Hide document panel',
  terminalShow: 'Show Terminal',
  terminalHide: 'Hide Terminal',
  // Palette forms for the two commands whose native-menu leaf renders a
  // different literal via the placement's `menuLabelText` ("Report a Bug" keeps
  // its capital B; the install leaf renders "…(desktop app)" lowercase), so only
  // these palette strings participate in the shared-label parity contract.
  reportBug: 'Report a bug',
  installClaudeDesktop: 'Install for Claude Chat & Cowork (Desktop App)',
} as const satisfies Record<string, string>;

export type MenuLabelKey = keyof typeof MENU_LABELS;

/**
 * Canonical repository URL shared by the native Help menu and the Cmd+K
 * palette's "OpenKnowledge on GitHub" command, so the two surfaces cannot
 * drift (the parity ratchets check labels, not URLs).
 */
export const OPEN_KNOWLEDGE_GITHUB_URL = 'https://github.com/inkeep/open-knowledge';
