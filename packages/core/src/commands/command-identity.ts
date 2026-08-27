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
  /** Requires the current surface to expose working PTY support. */
  readonly requiresTerminalCapability?: boolean;
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
  readonly terminalCapable: boolean;
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
  if (spec.requiresTerminalCapability && !ctx.terminalCapable) return false;
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
  | 'view-history'
  | 'terminal'
  | 'window'
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
   * Terminal Window) and the install leaf, whose native label renders
   * "…(desktop app)" lowercase. Takes precedence over `menuLabelKey`.
   */
  readonly menuLabelText?: string;
}

/** Show/Hide state-toggle labels (single menu row whose label flips on state). */
export interface CommandStateToggle {
  readonly showKey: MenuLabelKey;
  readonly hideKey: MenuLabelKey;
  /** View-menu-state field driving the label. */
  readonly stateField:
    | 'sidebarVisible'
    | 'docPanelVisible'
    | 'terminalVisible'
    | 'agentPanelVisible';
  /** Menu default when the state is unknown (sidebar/doc-panel start visible → "Hide"). */
  readonly defaultVisible: boolean;
  /**
   * A third label that REPLACES show/hide entirely while `overrideField` is
   * true, for a command whose action changes with state rather than merely
   * inverting.
   *
   * Exists because a show/hide pair can only ever describe a toggle. ⌘L stages a
   * selection instead of toggling when one exists, so with only the pair the
   * item promised "Hide Agents" and then neither hid them nor said what it did.
   * A menu item that cannot name its own action is worse than one with an
   * unusual name, so the override wins over the pair — never the reverse.
   */
  readonly overrideKey?: MenuLabelKey;
  readonly overrideField?: 'hasEditorSelection';
}

/** Terminal-placement labels (one row whose destination flips with its current home). */
interface CommandPlacementToggle {
  readonly bottomKey: MenuLabelKey;
  readonly rightKey: MenuLabelKey;
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
  /** Terminal placement metadata (bottom means offer right, and vice versa). */
  readonly placementToggle?: CommandPlacementToggle;
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
  // Palette-only, and search-only: findable by someone who goes looking,
  // invisible to someone who just opened the palette. Deliberately declares no
  // `menu` placement — a hidden game does not belong in the native menu bar.
  {
    id: 'open-blob-run',
    labelKey: 'blobRun',
    keywords: ['game', 'blob', 'runner', 'play', 'easter egg', 'dino'],
    availability: {},
    palette: { group: 'app', visibility: 'search-only' },
  },
  // ── Commands group (palette) / View-history (menu) ─────────────────────────
  {
    id: 'navigate-back',
    menuActionId: 'navigate-back',
    labelKey: 'back',
    keywords: ['previous history', 'go'],
    shortcutId: 'navigate-back',
    shortcutDesktopOnly: true,
    availability: { host: 'desktop' },
    palette: { group: 'commands', visibility: 'search-only' },
    menu: [
      { section: 'view-history', order: 0, platform: 'mac', accelerator: 'Cmd+[' },
      { section: 'view-history', order: 0, platform: 'other', accelerator: 'Alt+Left' },
    ],
  },
  {
    id: 'navigate-forward',
    menuActionId: 'navigate-forward',
    labelKey: 'forward',
    keywords: ['next history', 'go'],
    shortcutId: 'navigate-forward',
    shortcutDesktopOnly: true,
    availability: { host: 'desktop' },
    palette: { group: 'commands', visibility: 'search-only' },
    menu: [
      { section: 'view-history', order: 1, platform: 'mac', accelerator: 'Cmd+]' },
      { section: 'view-history', order: 1, platform: 'other', accelerator: 'Alt+Right' },
    ],
  },
  // ── Commands group (palette) / File-create (menu) ───────────────────────────
  {
    id: 'new-file',
    menuActionId: 'new-doc',
    labelKey: 'newFile',
    keywords: ['create file', 'document', 'note'],
    shortcutId: 'new-item',
    availability: {},
    palette: { group: 'commands', visibility: 'always' },
    menu: [{ section: 'file-create', order: 0, accelerator: 'CmdOrCtrl+N' }],
  },
  {
    id: 'new-folder',
    menuActionId: 'new-folder',
    labelKey: 'newFolder',
    keywords: ['create folder', 'directory'],
    shortcutId: 'new-folder',
    shortcutDesktopOnly: true,
    availability: {},
    palette: { group: 'commands', visibility: 'always' },
    menu: [{ section: 'file-create', order: 1, accelerator: 'CmdOrCtrl+Shift+N' }],
  },
  {
    id: 'open-graph',
    labelKey: 'openGraph',
    keywords: ['graph panel network', 'show', 'view'],
    availability: { requiresActiveDoc: true },
    palette: { group: 'commands', visibility: 'always' },
  },
  {
    // Pops the active document into its own window. Desktop-only (it spawns a
    // BrowserWindow) and needs a document to pop, so with neither the palette
    // simply omits the row — the palette's availability mechanism hides, it has
    // no disabled state. Hidden in a single-file session too: that window is
    // already one document, so a second one adds nothing.
    id: 'open-in-new-window',
    labelKey: 'openInNewWindow',
    keywords: ['pop out', 'detach', 'separate window', 'second monitor'],
    availability: { host: 'desktop', requiresActiveDoc: true, singleFileHidden: true },
    palette: { group: 'commands', visibility: 'always' },
    // The Window menu is where every incumbent puts this, and unlike the
    // palette a menu leaf DISABLES rather than hides, which is the right
    // affordance for a menu the user opened deliberately.
    menu: [{ section: 'window', order: 0 }],
  },
  {
    id: 'initialize-starter-pack',
    labelKey: 'initializeStarterPack',
    keywords: ['scaffold', 'seed', 'pack', 'starter'],
    availability: {},
    palette: { group: 'commands', visibility: 'always' },
  },
  {
    // Palette-only: "New skill" was never a native-menu leaf (it lives in the
    // Skills sidebar/hub), so the menu-parity backfill structurally never picked
    // it up. Creates a blank project-scope skill and opens it — no install.
    id: 'new-skill',
    labelKey: 'newSkill',
    keywords: ['skill', 'create', 'author', 'new'],
    availability: { singleFileHidden: true },
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
    keywords: ['project', 'folder', 'disk'],
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
    // Open a loose markdown file in a temporary single-file session (the desktop
    // side of `ok <file>`): no project setup, never writes `.ok` to the file's
    // folder. Sits right after Open folder in the File menu; the receiver
    // (`openEphemeralFile`) re-derives project-vs-ephemeral, so a file that
    // happens to live inside a project opens that project instead.
    id: 'open-file',
    labelKey: 'openFileOnDisk',
    keywords: ['file', 'markdown', 'single', 'standalone', 'temporary'],
    shortcutId: 'open-file',
    availability: { host: 'desktop' },
    palette: { group: 'project', visibility: 'always' },
    menu: [
      {
        section: 'file-project',
        order: 3,
        accelerator: 'CmdOrCtrl+Shift+O',
        ellipsis: true,
        menuLabelKey: 'openFile',
      },
    ],
  },
  {
    id: 'open-skills',
    labelKey: 'openSkills',
    keywords: ['skills marketplace explore import discover', 'browse', 'install', 'open'],
    availability: { singleFileHidden: true },
    palette: { group: 'project', visibility: 'always' },
    menu: [],
  },
  {
    id: 'switch-project',
    labelKey: 'switchProject',
    keywords: ['switch project navigator projects', 'change'],
    shortcutId: 'switch-project',
    availability: { host: 'desktop', singleFileHidden: true },
    palette: { group: 'project', visibility: 'always' },
    menu: [{ section: 'file-project', order: 1, accelerator: 'CmdOrCtrl+Shift+P', ellipsis: true }],
  },
  {
    id: 'settings',
    labelKey: 'settings',
    keywords: ['preferences config', 'open'],
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
    keywords: ['bug report issue feedback problem', 'file'],
    shortcutId: 'report-bug',
    // The chord reaches this command ONLY through the native accelerator below
    // — the app's shortcut registry declares it for display but wires no
    // keydown listener, so nothing in the renderer gates it on the app-global
    // overlay check the way every keydown listener does. On macOS that is the
    // whole story: AppKit resolves menu key equivalents ahead of the web view.
    // On Windows and Linux the accelerator still travels the renderer's input
    // path first, so a focused surface that cancels the chord cancels the menu
    // item with it.
    shortcutDesktopOnly: true,
    availability: { host: 'desktop' },
    palette: { group: 'project', visibility: 'always' },
    menu: [{ section: 'help-links', order: 1, ellipsis: true, accelerator: 'CmdOrCtrl+Shift+D' }],
  },
  {
    // Palette-only sibling of report-bug (no `menu` placement): the persisted
    // history/retry list for reports that were generated but never accepted by
    // the intake. Desktop-only for the same reason report-bug is — the sidecar
    // store and the retry upload both live behind the Electron bridge.
    id: 'bug-report-history',
    labelKey: 'bugReportHistory',
    keywords: ['bug report history previous reports past retry resend'],
    availability: { host: 'desktop' },
    palette: { group: 'project', visibility: 'always' },
  },
  {
    // Sibling of report-bug, but host-agnostic: the feedback form POSTs to the
    // hosted intake route, so it works in the web host too (unlike the bug
    // report, whose bundle create + upload lives behind the Electron bridge).
    id: 'send-feedback',
    menuActionId: 'send-feedback',
    labelKey: 'sendFeedback',
    keywords: ['feedback', 'suggestion', 'idea', 'rate', 'survey', 'contact', 'give'],
    availability: {},
    palette: { group: 'project', visibility: 'always' },
    menu: [{ section: 'help-links', order: 2, ellipsis: true }],
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
    keywords: ['delete', 'trash', 'remove', 'file', 'folder'],
    shortcutId: 'file-tree-delete',
    availability: { host: 'desktop', requiresTargetKinds: ['doc', 'folder', 'asset'] },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-item', order: 2, accelerator: 'CmdOrCtrl+Delete' }],
  },
  {
    id: 'reveal-in-finder',
    menuActionId: 'reveal-in-finder',
    labelKey: 'revealInFinder',
    keywords: ['finder', 'reveal', 'show', 'file', 'folder', 'open'],
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
    keywords: ['worktree', 'branch', 'new', 'create'],
    availability: { host: 'desktop' },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-worktree', order: 0, ellipsis: true }],
  },
  {
    id: 'switch-worktree',
    menuActionId: 'switch-worktree',
    labelKey: 'switchWorktree',
    keywords: ['worktree', 'switch', 'branch', 'change', 'checkout'],
    availability: { host: 'desktop' },
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-worktree', order: 1, ellipsis: true }],
  },
  // ── View group (palette) / View-panels + visibility + tree (menu) ───────────
  {
    id: 'toggle-sidebar',
    menuActionId: 'toggle-sidebar',
    labelKey: 'sidebarHide',
    keywords: ['sidebar', 'files', 'panel', 'toggle', 'show', 'hide', 'open'],
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
    keywords: ['document', 'panel', 'info', 'toggle', 'properties', 'show', 'hide', 'open'],
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
    keywords: [
      'terminal',
      'shell',
      'console',
      'panel',
      'toggle terminal',
      'toggle bottom dock',
      'show terminal',
      'hide terminal',
      // In most editors "close terminal" dismisses the panel. Kill Terminal
      // also carries `close`, and it destroys a live shell with no confirm and
      // no undo, so without this the destructive row is the only answer to that
      // phrasing. Both now match, and the view group renders above the terminal
      // group, so the reversible one is preselected.
      'close',
      'open',
    ],
    shortcutId: 'toggle-terminal-panel',
    stateToggle: {
      showKey: 'terminalShow',
      hideKey: 'terminalHide',
      stateField: 'terminalVisible',
      defaultVisible: false,
    },
    availability: { host: 'desktop', requiresTerminalCapability: true },
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-panels', order: 2, accelerator: 'CmdOrCtrl+J' }],
  },
  {
    // The agents panel is the ACP twin of the terminal dock, but it is NOT
    // desktop-gated: agent threads are server-hosted, so the panel works on the
    // web host and on Windows/Linux where node-pty is unavailable.
    id: 'toggle-agent-panel',
    menuActionId: 'toggle-agent-panel',
    labelKey: 'agentPanelShow',
    keywords: ['agent', 'agents', 'chat', 'ai', 'ask', 'panel', 'toggle', 'open', 'show', 'hide'],
    shortcutId: 'toggle-agent-panel',
    stateToggle: {
      showKey: 'agentPanelShow',
      hideKey: 'agentPanelHide',
      stateField: 'agentPanelVisible',
      defaultVisible: false,
      overrideKey: 'agentPanelAskSelection',
      overrideField: 'hasEditorSelection',
    },
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-panels', order: 3, accelerator: 'CmdOrCtrl+L' }],
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
    availability: { host: 'desktop', requiresTerminalCapability: true },
    palette: { group: 'terminal', visibility: 'search-only' },
    menu: [{ section: 'terminal', order: 0 }],
  },
  {
    // Menu-only leaf; opens a dedicated terminal window in main (no renderer handler).
    id: 'new-terminal-window',
    keywords: [],
    availability: { host: 'desktop', requiresTerminalCapability: true },
    menu: [{ section: 'terminal', order: 1, menuLabelText: 'New Terminal Window' }],
  },
  {
    id: 'move-terminal',
    menuActionId: 'move-terminal',
    labelKey: 'terminalMoveRight',
    keywords: ['terminal', 'move', 'dock', 'right', 'bottom', 'placement'],
    placementToggle: {
      bottomKey: 'terminalMoveRight',
      rightKey: 'terminalMoveBottom',
    },
    availability: { host: 'desktop', requiresTerminalCapability: true },
    palette: { group: 'terminal', visibility: 'search-only' },
    menu: [{ section: 'terminal', order: 2 }],
  },
  {
    id: 'kill-terminal',
    menuActionId: 'kill-terminal',
    labelKey: 'killTerminal',
    keywords: ['terminal', 'kill', 'close', 'session', 'stop'],
    availability: {
      host: 'desktop',
      requiresTerminalCapability: true,
      requiresTerminalLive: true,
    },
    palette: { group: 'terminal', visibility: 'search-only' },
    menu: [{ section: 'terminal', order: 3 }],
  },
  // ── Application group (palette) / App + Edit + Help (menu) ───────────────────
  {
    id: 'check-for-updates',
    labelKey: 'checkForUpdates',
    keywords: ['update', 'upgrade', 'version', 'check', 'app'],
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
    keywords: ['github', 'source', 'repository', 'code', 'view'],
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
