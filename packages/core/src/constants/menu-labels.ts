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
  openFile: 'Open file',
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
  // Deliberately verb-less (unlike the sibling "Show …" filters): this toggles a
  // whole sidebar section, and "Show skills section" read as an action that only
  // ever shows — confusing when the item is checked and clicking it hides (7605).
  // The checkbox check state carries the current-visibility signal.
  showSkillsSection: 'Skills section',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  // Move to Trash keeps "Trash" capitalized — the macOS/Linux destination proper
  // noun, same treatment as Finder / Terminal above. Windows swaps in "Recycle
  // Bin" via PLATFORM_MENU_LABELS below.
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
  reportBug: 'Report a bug',
  bugReportHistory: 'Bug report history',
  sendFeedback: 'Send feedback',
  // Additional shared command labels the registry references. Each string is
  // rendered identically by the palette, so the parity test stays green. The
  // native menu appends the … ellipsis at its call site where the command opens
  // a new surface (Switch project…, Settings…).
  switchProject: 'Switch project',
  openSkills: 'Skills',
  settings: 'Settings',
  // Open folder's palette row is the descriptive "Open folder on disk"; the
  // native File menu renders the terser "Open folder…" via `openFolder` above.
  openFolderOnDisk: 'Open folder on disk',
  // Open file's palette + Navigator row is the descriptive "Open file on disk";
  // the native File menu renders the terser "Open file…" via `openFile` above.
  // Opens a loose markdown file in a temporary single-file session (no project
  // setup, no `.ok` written to its folder) — the desktop side of `ok <file>`.
  openFileOnDisk: 'Open file on disk',
  // Palette-only commands (no native-menu leaf); shared here so the label-parity
  // test guards them and the registry keeps a single label source.
  openGraph: 'Open graph',
  blobRun: 'Blob Run',
  initializeStarterPack: 'Initialize starter pack',
  newSkill: 'New skill',
  // State-aware Show/Hide toggles — both surfaces render both variants; the
  // native menu is a single row whose label flips on the pushed view-menu-state.
  sidebarShow: 'Show sidebar',
  sidebarHide: 'Hide sidebar',
  docPanelShow: 'Show document panel',
  docPanelHide: 'Hide document panel',
  back: 'Back',
  forward: 'Forward',
  terminalShow: 'Show Terminal',
  terminalHide: 'Hide Terminal',
  terminalMoveRight: 'Move Terminal to right',
  terminalMoveBottom: 'Move Terminal to bottom',
  agentPanelShow: 'Show Agents',
  agentPanelHide: 'Hide Agents',
  // ⌘L stages a selection rather than toggling when one exists, so the item
  // renames itself to what it will actually do. Without this it reads "Hide
  // Agents" and then does not hide them.
  agentPanelAskSelection: 'Ask AI About Selection',
  // Palette form for the install command, whose native-menu leaf renders a
  // different literal via the placement's `menuLabelText` ("…(desktop app)"
  // lowercase), so only this palette string participates in the shared-label
  // parity contract.
  installClaudeDesktop: 'Install for Claude Chat & Cowork (Desktop App)',
} as const satisfies Record<string, string>;

export type MenuLabelKey = keyof typeof MENU_LABELS;

/**
 * Per-platform overrides for the handful of labels that name an OS surface.
 * `MENU_LABELS` keeps the macOS strings (the historical defaults, and what the
 * web build shows when no desktop bridge is present); Windows and Linux swap in
 * their own via `menuLabelForPlatform`.
 *
 * Vocabulary mirrors VS Code: "Reveal in File Explorer" on Windows and "Open
 * containing folder" on Linux. The Linux verb asymmetry (Open vs Reveal) is
 * intentional — there is no stable Linux file-manager brand to "Reveal in";
 * a normalizing fix to "Reveal in Files" would be incorrect on most distros.
 * The renderer mirrors these strings in Lingui macros (which need literals at
 * the call site) — the label-parity test keeps the two sides in lockstep.
 */
export const PLATFORM_MENU_LABELS: Partial<
  Record<MenuLabelKey, Partial<Record<'win32' | 'linux', string>>>
> = {
  revealInFinder: { win32: 'Reveal in File Explorer', linux: 'Open containing folder' },
  moveToTrash: { win32: 'Move to Recycle Bin' },
};

/** Resolve a menu label for a platform (`process.platform`-style identifier). */
export function menuLabelForPlatform(key: MenuLabelKey, platform: string): string {
  const overrides = PLATFORM_MENU_LABELS[key];
  if (overrides && (platform === 'win32' || platform === 'linux')) {
    const override = overrides[platform];
    if (override !== undefined) return override;
  }
  return MENU_LABELS[key];
}

/**
 * Canonical repository URL shared by the native Help menu and the Cmd+K
 * palette's "OpenKnowledge on GitHub" command, so the two surfaces cannot
 * drift (the parity ratchets check labels, not URLs).
 */
export const OPEN_KNOWLEDGE_GITHUB_URL = 'https://github.com/inkeep/open-knowledge';
