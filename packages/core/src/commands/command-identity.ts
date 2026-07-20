import type { MenuLabelKey } from '../constants/menu-labels.ts';

/**
 * Shared, serializable command identity for OpenKnowledge's global command
 * surfaces — the ONE declaration point the native Electron menu
 * (`packages/desktop/src/main/menu.ts`) and the Cmd+K palette
 * (`packages/app/src/components/command-palette-commands.ts`) both render from.
 *
 * This module is CORE: browser + node safe, Lingui-free, `tsdown`-built (no
 * macro transform). So every field here is PLAIN DATA — no functions, no
 * `lucide-react` icons, no Lingui `msg` descriptors. Each surface joins this
 * identity with its own presentation (the menu adds plain labels + click deps;
 * the palette adds `msg` labels + `lucide` icons + dispatch closures).
 *
 * `menuActionId` and `shortcutId` are typed as bare strings here because their
 * unions (`OkMenuAction`, `KeyboardShortcutId`) live in the desktop/app
 * packages, which core cannot import. The app/desktop wrappers narrow them, and
 * the parity ratchets (`command-menu-parity.test.ts`) assert every id is real.
 */

/** Palette render buckets; the palette renders each group under its own heading. */
export type CommandGroup = 'commands' | 'project' | 'file' | 'view' | 'terminal' | 'app';

/**
 * Projected active-target kind, shared by both surfaces' availability contexts.
 * `project` is the menu's project-scope signal (a window is open on a project,
 * no file selected — contentDir is still an actionable target); `none` is the
 * palette's "no target" signal. Keeping them distinct lets one availability
 * spec drive both surfaces: `reveal-in-finder` / copy-path are actionable in
 * project scope (menu) yet hidden with no target (palette), which is exactly
 * `requiresTargetKinds` including `project` but not `none`.
 */
export type ContextualTargetKind = 'doc' | 'folder' | 'asset' | 'project' | 'none';

/** Host gate. `all` = web + desktop; `desktop` hides on the web host. */
export type CommandHostScope = 'all' | 'desktop';

/**
 * Declarative availability. The pure {@link evaluateCommandAvailability}
 * evaluates this against a {@link CommandContext}; the menu maps the result to
 * `enabled` (or `visible`, for smart-hidden tree commands) and the palette maps
 * it to whether the row renders. Every field references DATA only, so this
 * predicate stays core-safe: a declarative spec + pure evaluator, never a
 * renderer-reaching predicate.
 */
export interface CommandAvailabilitySpec {
  /** Host gate; defaults to `all`. */
  readonly host?: CommandHostScope;
  /** Active target must project to one of these kinds. */
  readonly requiresTargetKinds?: readonly ContextualTargetKind[];
  /** Hidden in a no-project single-file session. */
  readonly singleFileHidden?: boolean;
  /** Requires a live (mounted) terminal session. */
  readonly requiresTerminalLive?: boolean;
  /** Requires an expandable tree (smart-hide when everything is expanded). */
  readonly requiresCanExpandAll?: boolean;
  /** Requires a collapsible tree (smart-hide when everything is collapsed). */
  readonly requiresCanCollapseAll?: boolean;
  /** Requires an active document (e.g. Open graph). */
  readonly requiresActiveDoc?: boolean;
  /** Requires the install-skill feature flag (`SHOW_INSTALL_SKILL`). */
  readonly requiresInstallSkill?: boolean;
}

/**
 * The DATA a command needs to decide availability, assembled per render by each
 * surface: the menu from the IPC-pushed active-target snapshot + platform; the
 * palette from `DocumentContext` + the view-menu-state store. Booleans are
 * pre-normalized by the caller (e.g. `canExpandAll = raw !== false`,
 * `terminalLive = raw === true`) so the evaluator stays a plain membership test.
 */
export interface CommandContext {
  readonly host: 'desktop' | 'web';
  readonly activeTargetKind: ContextualTargetKind;
  readonly singleFile: boolean;
  readonly terminalLive: boolean;
  readonly canExpandAll: boolean;
  readonly canCollapseAll: boolean;
  readonly hasActiveDoc: boolean;
  readonly showInstallSkill: boolean;
}

/** Pure availability predicate. No side effects, no renderer/desktop concepts. */
export function evaluateCommandAvailability(
  spec: CommandAvailabilitySpec,
  ctx: CommandContext,
): boolean {
  if (spec.host === 'desktop' && ctx.host !== 'desktop') return false;
  if (spec.singleFileHidden && ctx.singleFile) return false;
  if (spec.requiresTerminalLive && !ctx.terminalLive) return false;
  if (spec.requiresCanExpandAll && !ctx.canExpandAll) return false;
  if (spec.requiresCanCollapseAll && !ctx.canCollapseAll) return false;
  if (spec.requiresActiveDoc && !ctx.hasActiveDoc) return false;
  if (spec.requiresInstallSkill && !ctx.showInstallSkill) return false;
  if (spec.requiresTargetKinds && !spec.requiresTargetKinds.includes(ctx.activeTargetKind)) {
    return false;
  }
  return true;
}

/** Which platform's menu bar a placement targets. `all` = both. */
export type MenuPlatform = 'all' | 'mac' | 'other';

/**
 * Named slots in the native menu's declarative scaffolding. `buildMenuTemplate`
 * owns the roles / separators / submenu parents / recents around these; each
 * command leaf declares which slot it lands in and at what order. A command may
 * declare more than one placement (e.g. Settings / Check for updates are
 * platform-XOR: one `mac` placement, one `other`), which is how the
 * "Check for updates" duplicate becomes data instead of a hand-branch.
 */
export type MenuSection =
  | 'app-updates'
  | 'app-settings'
  | 'app-uninstall'
  | 'file-create'
  | 'file-project'
  | 'file-worktree'
  | 'file-item'
  | 'file-reveal'
  | 'file-copy-path'
  | 'file-integrations'
  | 'file-settings'
  | 'file-close'
  | 'edit-spell'
  | 'view-panels'
  | 'view-visibility'
  | 'view-tree'
  | 'terminal'
  | 'help-install'
  | 'help-links'
  | 'help-updates';

export interface CommandMenuPlacement {
  readonly section: MenuSection;
  /** Sort key within the section (menu leaves render in ascending order). */
  readonly order: number;
  /** Platform gate; defaults to `all`. */
  readonly platform?: MenuPlatform;
  /** Electron accelerator, single-sourced here; a parity test asserts it agrees
   *  with the app's keyboard-shortcut registry (the two share no import). */
  readonly accelerator?: string;
  /** Append the native "opens a new surface" ellipsis (…) at render time. */
  readonly ellipsis?: boolean;
  /** Render as an Electron checkbox item. */
  readonly checkbox?: boolean;
  /** Smart-hide: map availability to `visible` (not `enabled`) — Expand/Collapse all. */
  readonly smartHide?: boolean;
  /**
   * Menu label key override into `MENU_LABELS`, when the native menu renders a
   * different label than the palette (e.g. Copy path's children are "Full path"
   * / "Relative path" in the menu, "Copy full path" / "Copy relative path" in
   * the palette). Defaults to the command's `labelKey`.
   */
  readonly menuLabelKey?: MenuLabelKey;
  /**
   * Literal native-menu label, for the handful of menu strings that are NOT in
   * the shared `MENU_LABELS` parity contract: menu-only leaves (Uninstall, New
   * Terminal Window) and two leaves whose native label predates the app's
   * sentence-case convention and stays byte-identical here (Report a Bug,
   * Install…(desktop app)). Takes precedence over `menuLabelKey`.
   */
  readonly menuLabelText?: string;
}

/** Show/Hide state-toggle labels (single menu row whose label flips on state). */
export interface CommandStateToggle {
  readonly showKey: MenuLabelKey;
  readonly hideKey: MenuLabelKey;
  /** View-menu-state field driving the label. */
  readonly stateField: 'sidebarVisible' | 'docPanelVisible' | 'terminalVisible';
  /** Menu default when the state is unknown (sidebar/doc-panel start visible → "Hide"). */
  readonly defaultVisible: boolean;
}

/** View-menu-state checkbox field a command's check indicator reads. */
export type CommandCheckField =
  | 'showHiddenFiles'
  | 'showOkFolders'
  | 'showOnlyMarkdownFiles'
  | 'showSkillsSection';

/** Palette presentation hints (serializable subset; icon/label/dispatch are app-side). */
export interface CommandPalettePresence {
  readonly group: CommandGroup;
  /** `always` renders on empty open; `search-only` renders only under a matching query. */
  readonly visibility: 'always' | 'search-only';
}

export interface CommandIdentity {
  /** Stable id; the palette DOM testid is `command-palette-${id}`. */
  readonly id: string;
  /** The `OkMenuAction` this command dispatches, when it routes through the menu-action bus. */
  readonly menuActionId?: string;
  /**
   * Canonical label key (into `MENU_LABELS`) — the palette's label + the menu's
   * default. Omitted for menu-only leaves that render a literal `menuLabelText`
   * (Uninstall, New Terminal Window) with no palette row.
   */
  readonly labelKey?: MenuLabelKey;
  /** Extra `matchesCommandQuery` tokens beyond the label. Not localized. */
  readonly keywords: readonly string[];
  /** Keyboard-shortcut id whose accelerator the palette renders (`formatShortcut`). */
  readonly shortcutId?: string;
  /** The shortcut only fires via a native-menu accelerator (no web keydown). */
  readonly shortcutDesktopOnly?: boolean;
  /** Show/Hide toggle metadata (sidebar / document panel / terminal). */
  readonly stateToggle?: CommandStateToggle;
  /** Checkbox check-state field (palette check indicator + menu checked source). */
  readonly checkField?: CommandCheckField;
  readonly availability: CommandAvailabilitySpec;
  /** Palette presence (omitted for menu-only commands: send-to-ai, uninstall, new-terminal-window). */
  readonly palette?: CommandPalettePresence;
  /** Native-menu placement(s) (omitted for palette-only commands: open-graph, initialize-starter-pack). */
  readonly menu?: readonly CommandMenuPlacement[];
}

/**
 * The command identity registry. Order matches the palette's row order
 * within each group (the palette filters by group and preserves array order).
 * Menu-only commands are interleaved near their menu neighbors.
 */
export const COMMAND_IDENTITIES: readonly CommandIdentity[] = [
  // ── Commands group (palette) / File-create (menu) ───────────────────────────
  {
    id: 'new-file',
    menuActionId: 'new-doc',
    labelKey: 'newFile',
    keywords: ['create file'],
    shortcutId: 'new-item',
    availability: {},
    palette: { group: 'commands', visibility: 'always' },
    menu: [{ section: 'file-create', order: 0, accelerator: 'CmdOrCtrl+N' }],
  },
  {
    id: 'new-folder',
    menuActionId: 'new-folder',
    labelKey: 'newFolder',
    keywords: ['create folder'],
    shortcutId: 'new-folder',
    shortcutDesktopOnly: true,
    availability: {},
    palette: { group: 'commands', visibility: 'always' },
    menu: [{ section: 'file-create', order: 1, accelerator: 'CmdOrCtrl+Shift+N' }],
  },
  {
    id: 'open-graph',
    labelKey: 'openGraph',
    keywords: ['graph panel network'],
    availability: { requiresActiveDoc: true },
    palette: { group: 'commands', visibility: 'always' },
  },
  {
    id: 'initialize-starter-pack',
    labelKey: 'initializeStarterPack',
    keywords: ['scaffold', 'seed', 'pack', 'starter'],
    availability: {},
    palette: { group: 'commands', visibility: 'always' },
  },
  // ── Project group (palette) / File-project (menu) ───────────────────────────
  {
    id: 'new-project',
    menuActionId: 'new-project',
    labelKey: 'newProject',
    keywords: ['create new project scaffold'],
    availability: { host: 'desktop' },
    palette: { group: 'project', visibility: 'always' },
    menu: [{ section: 'file-project', order: 0, ellipsis: true }],
  },
  {
    id: 'open-folder',
    labelKey: 'openFolderOnDisk',
    keywords: ['project'],
    shortcutId: 'open-folder',
    availability: { host: 'desktop' },
    palette: { group: 'project', visibility: 'always' },
    menu: [
      {
        section: 'file-project',
        order: 2,
        accelerator: 'CmdOrCtrl+O',
        ellipsis: true,
        menuLabelKey: 'openFolder',
      },
    ],
  },
  {
    id: 'switch-project',
    labelKey: 'switchProject',
    keywords: ['switch project navigator projects'],
    shortcutId: 'switch-project',
    availability: { host: 'desktop', singleFileHidden: true },
    palette: { group: 'project', visibility: 'always' },
    menu: [{ section: 'file-project', order: 1, accelerator: 'CmdOrCtrl+Shift+P', ellipsis: true }],
  },
  {
    id: 'settings',
    labelKey: 'settings',
    keywords: ['preferences config'],
    shortcutId: 'settings',
    availability: { singleFileHidden: true },
    palette: { group: 'project', visibility: 'always' },
    menu: [
      {
        section: 'app-settings',
        order: 0,
        platform: 'mac',
        accelerator: 'CmdOrCtrl+,',
        ellipsis: true,
      },
      {
        section: 'file-settings',
        order: 0,
        platform: 'other',
        accelerator: 'CmdOrCtrl+,',
        ellipsis: true,
      },
    ],
  },
  {
    id: 'install-claude-desktop',
    labelKey: 'installClaudeDesktop',
    keywords: ['claude desktop install cowork'],
    availability: { requiresInstallSkill: true },
    palette: { group: 'project', visibility: 'always' },
    menu: [
      {
        section: 'help-install',
        order: 0,
        ellipsis: true,
        menuLabelText: 'Install for Claude Chat & Cowork (desktop app)',
      },
    ],
  },
  {
    id: 'report-bug',
    menuActionId: 'report-bug',
    labelKey: 'reportBug',
    keywords: ['bug report issue feedback problem'],
    availability: { host: 'desktop' },
    palette: { group: 'project', visibility: 'always' },
    menu: [{ section: 'help-links', order: 1, ellipsis: true, menuLabelText: 'Report a Bug' }],
  },
  // ── File group (palette) / File-item + worktree (menu) ──────────────────────
  {
    id: 'new-from-template',
    menuActionId: 'new-from-template',
    labelKey: 'newFromTemplate',
    keywords: ['template', 'create', 'new'],
    availability: { singleFileHidden: true },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-create', order: 2, ellipsis: true }],
  },
  {
    id: 'rename',
    menuActionId: 'rename',
    labelKey: 'rename',
    keywords: ['rename', 'file', 'folder'],
    availability: { host: 'desktop', requiresTargetKinds: ['doc', 'folder', 'asset'] },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-item', order: 1 }],
  },
  {
    id: 'duplicate',
    menuActionId: 'duplicate',
    labelKey: 'duplicate',
    keywords: ['duplicate', 'copy', 'file', 'folder'],
    shortcutId: 'file-tree-duplicate',
    availability: { host: 'desktop', requiresTargetKinds: ['doc', 'folder'] },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-item', order: 0, accelerator: 'CmdOrCtrl+D' }],
  },
  {
    id: 'move-to-trash',
    menuActionId: 'move-to-trash',
    labelKey: 'moveToTrash',
    keywords: ['delete', 'trash', 'remove'],
    shortcutId: 'file-tree-delete',
    availability: { host: 'desktop', requiresTargetKinds: ['doc', 'folder', 'asset'] },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-item', order: 2, accelerator: 'CmdOrCtrl+Delete' }],
  },
  {
    id: 'reveal-in-finder',
    menuActionId: 'reveal-in-finder',
    labelKey: 'revealInFinder',
    keywords: ['finder', 'reveal', 'show', 'file'],
    availability: { host: 'desktop', requiresTargetKinds: ['doc', 'folder', 'asset', 'project'] },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-reveal', order: 0 }],
  },
  {
    // Menu-only "Open with AI" leaf. The palette surfaces send-to-ai as a
    // bespoke per-target Open-with-AI group, not a fixed registry row.
    id: 'send-to-ai',
    menuActionId: 'send-to-ai',
    labelKey: 'openWithAi',
    keywords: ['ai', 'agent', 'handoff'],
    availability: { host: 'desktop', requiresTargetKinds: ['doc', 'folder', 'project'] },
    menu: [{ section: 'file-reveal', order: 1 }],
  },
  {
    id: 'copy-full-path',
    menuActionId: 'copy-full-path',
    labelKey: 'copyFullPath',
    keywords: ['copy', 'path', 'absolute', 'full'],
    availability: { host: 'desktop', requiresTargetKinds: ['doc', 'folder', 'asset', 'project'] },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-copy-path', order: 0, menuLabelKey: 'fullPath' }],
  },
  {
    id: 'copy-relative-path',
    menuActionId: 'copy-relative-path',
    labelKey: 'copyRelativePath',
    keywords: ['copy', 'path', 'relative'],
    availability: { host: 'desktop', requiresTargetKinds: ['doc', 'folder', 'asset', 'project'] },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-copy-path', order: 1, menuLabelKey: 'relativePath' }],
  },
  {
    id: 'close-tab',
    menuActionId: 'close-active-tab-or-window',
    labelKey: 'closeTab',
    keywords: ['close', 'tab', 'window'],
    availability: { host: 'desktop' },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-close', order: 0, platform: 'mac', accelerator: 'CmdOrCtrl+W' }],
  },
  {
    id: 'new-worktree',
    menuActionId: 'new-worktree',
    labelKey: 'newWorktree',
    keywords: ['worktree', 'branch', 'new'],
    availability: { host: 'desktop' },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-worktree', order: 0, ellipsis: true }],
  },
  {
    id: 'switch-worktree',
    menuActionId: 'switch-worktree',
    labelKey: 'switchWorktree',
    keywords: ['worktree', 'switch', 'branch'],
    availability: { host: 'desktop' },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-worktree', order: 1, ellipsis: true }],
  },
  // ── View group (palette) / View-panels + visibility + tree (menu) ───────────
  {
    id: 'toggle-sidebar',
    menuActionId: 'toggle-sidebar',
    labelKey: 'sidebarHide',
    keywords: ['sidebar', 'files', 'panel', 'toggle'],
    shortcutId: 'toggle-files-sidebar',
    stateToggle: {
      showKey: 'sidebarShow',
      hideKey: 'sidebarHide',
      stateField: 'sidebarVisible',
      defaultVisible: true,
    },
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-panels', order: 0, accelerator: 'CmdOrCtrl+Alt+S' }],
  },
  {
    id: 'toggle-doc-panel',
    menuActionId: 'toggle-doc-panel',
    labelKey: 'docPanelHide',
    keywords: ['document', 'panel', 'info', 'toggle'],
    shortcutId: 'toggle-document-panel',
    stateToggle: {
      showKey: 'docPanelShow',
      hideKey: 'docPanelHide',
      stateField: 'docPanelVisible',
      defaultVisible: true,
    },
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-panels', order: 1, accelerator: 'CmdOrCtrl+Alt+B' }],
  },
  {
    id: 'toggle-terminal',
    menuActionId: 'toggle-terminal',
    labelKey: 'terminalShow',
    keywords: ['terminal', 'shell', 'console', 'toggle'],
    shortcutId: 'toggle-terminal-panel',
    stateToggle: {
      showKey: 'terminalShow',
      hideKey: 'terminalHide',
      stateField: 'terminalVisible',
      defaultVisible: false,
    },
    availability: { host: 'desktop' },
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-panels', order: 2, accelerator: 'CmdOrCtrl+J' }],
  },
  {
    id: 'toggle-show-hidden-files',
    menuActionId: 'toggle-show-hidden-files',
    labelKey: 'showHiddenFiles',
    keywords: ['hidden', 'dotfiles', 'files', 'show'],
    checkField: 'showHiddenFiles',
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [
      { section: 'view-visibility', order: 0, accelerator: 'CmdOrCtrl+Shift+.', checkbox: true },
    ],
  },
  {
    id: 'toggle-show-ok-folders',
    menuActionId: 'toggle-show-ok-folders',
    labelKey: 'showOkFolders',
    keywords: ['ok', 'folders', 'hidden', 'show'],
    checkField: 'showOkFolders',
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-visibility', order: 1, checkbox: true }],
  },
  {
    id: 'toggle-show-only-markdown-files',
    menuActionId: 'toggle-show-only-markdown-files',
    labelKey: 'showOnlyMarkdownFiles',
    keywords: ['markdown', 'filter', 'files', 'only'],
    checkField: 'showOnlyMarkdownFiles',
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-visibility', order: 2, checkbox: true }],
  },
  {
    id: 'toggle-show-skills-section',
    menuActionId: 'toggle-show-skills-section',
    labelKey: 'showSkillsSection',
    keywords: ['skills', 'section', 'sidebar', 'show'],
    checkField: 'showSkillsSection',
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-visibility', order: 3, checkbox: true }],
  },
  {
    id: 'expand-all-tree',
    menuActionId: 'expand-all-tree',
    labelKey: 'expandAll',
    keywords: ['expand', 'tree', 'folders', 'all'],
    availability: { requiresCanExpandAll: true },
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-tree', order: 0, smartHide: true }],
  },
  {
    id: 'collapse-all-tree',
    menuActionId: 'collapse-all-tree',
    labelKey: 'collapseAll',
    keywords: ['collapse', 'tree', 'folders', 'all'],
    availability: { requiresCanCollapseAll: true },
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-tree', order: 1, smartHide: true }],
  },
  // ── Terminal group (palette) / Terminal (menu) ──────────────────────────────
  {
    id: 'new-terminal',
    menuActionId: 'new-terminal',
    labelKey: 'newTerminal',
    keywords: ['terminal', 'shell', 'new', 'tab'],
    availability: { host: 'desktop' },
    palette: { group: 'terminal', visibility: 'search-only' },
    menu: [{ section: 'terminal', order: 0 }],
  },
  {
    // Menu-only leaf; opens a dedicated terminal window in main (no renderer handler).
    id: 'new-terminal-window',
    keywords: [],
    availability: { host: 'desktop' },
    menu: [{ section: 'terminal', order: 1, menuLabelText: 'New Terminal Window' }],
  },
  {
    id: 'kill-terminal',
    menuActionId: 'kill-terminal',
    labelKey: 'killTerminal',
    keywords: ['terminal', 'kill', 'close', 'session'],
    availability: { host: 'desktop', requiresTerminalLive: true },
    palette: { group: 'terminal', visibility: 'search-only' },
    menu: [{ section: 'terminal', order: 2 }],
  },
  // ── Application group (palette) / App + Edit + Help (menu) ───────────────────
  {
    id: 'check-for-updates',
    labelKey: 'checkForUpdates',
    keywords: ['update', 'upgrade', 'version', 'check'],
    availability: { host: 'desktop' },
    palette: { group: 'app', visibility: 'search-only' },
    menu: [
      { section: 'app-updates', order: 0, platform: 'mac', ellipsis: true },
      { section: 'help-updates', order: 0, platform: 'other', ellipsis: true },
    ],
  },
  {
    id: 'set-up-integrations',
    labelKey: 'setUpIntegrations',
    keywords: ['integrations', 'mcp', 'setup', 'claude', 'configure'],
    availability: { host: 'desktop' },
    palette: { group: 'app', visibility: 'search-only' },
    menu: [{ section: 'file-integrations', order: 0, ellipsis: true }],
  },
  {
    id: 'toggle-spell-check',
    labelKey: 'checkSpelling',
    keywords: ['spell', 'spelling', 'check', 'typing'],
    availability: { host: 'desktop' },
    palette: { group: 'app', visibility: 'search-only' },
    menu: [{ section: 'edit-spell', order: 0, checkbox: true }],
  },
  {
    id: 'open-github',
    labelKey: 'openOnGithub',
    keywords: ['github', 'source', 'repository', 'code'],
    availability: {},
    palette: { group: 'app', visibility: 'search-only' },
    menu: [{ section: 'help-links', order: 0 }],
  },
  {
    // Menu-only leaf; macOS App menu, presence-gated + rare/destructive.
    id: 'uninstall',
    keywords: [],
    availability: { host: 'desktop' },
    menu: [
      {
        section: 'app-uninstall',
        order: 0,
        platform: 'mac',
        ellipsis: true,
        menuLabelText: 'Uninstall OpenKnowledge',
      },
    ],
  },
];
