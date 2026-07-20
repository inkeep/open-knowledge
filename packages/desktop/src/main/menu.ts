/**
 * Application menu — baseline.
 *
 * Covers the File / Edit / View / Window scope:
 *   - File: Switch project (open Navigator), Open folder (native picker),
 *     Recent project submenu, Close Window
 *   - Edit: macOS defaults (Undo/Redo/Cut/Copy/Paste/Select All)
 *   - View: Reload / Force Reload / zoom / fullscreen always; Toggle DevTools
 *     gated on `showDevToolsMenu` (dev + beta only) — Electron built-in roles
 *   - Window: macOS defaults (Minimize / Zoom / Bring to Front)
 *
 * Deferred to later work:
 *   - Project menu (Save Version, Version History, Reveal .ok/, Trust Project)
 *   - File → Clone from GitHub…
 *   - View → Graph / Timeline / Backlinks / Outline toggles
 *   - Help → Documentation
 *
 * The menu is rebuilt on recent-projects changes so the Recent project submenu
 * stays current without us reaching into Electron's menu-item mutation API
 * (Electron recommends full rebuild on state change).
 *
 * Electron import discipline: `electron` named exports (Menu, app, dialog,
 * shell) are only resolvable at runtime inside an Electron process. Bun's
 * unit-test runner loads the `electron` npm package, which is just a string
 * path to the binary — it has NO named exports. So this module uses
 * type-only imports for interface types (MenuItemConstructorOptions) and
 * pulls the one runtime value we need (`app.name`) + side-effecting APIs
 * (Menu.setApplicationMenu, Menu.buildFromTemplate, dialog.showOpenDialog)
 * via a dynamic `await import('electron')` inside `installApplicationMenu`.
 * That keeps `buildMenuTemplate` — the pure function tests exercise —
 * free of runtime electron bindings.
 */

import {
  COMMAND_IDENTITIES,
  type CommandContext,
  type CommandIdentity,
  type CommandMenuPlacement,
  type ContextualTargetKind,
  evaluateCommandAvailability,
  MENU_LABELS,
  type MenuSection,
  OPEN_KNOWLEDGE_GITHUB_URL,
  SHOW_INSTALL_SKILL,
} from '@inkeep/open-knowledge-core';
import type { Dialog, MenuItemConstructorOptions } from 'electron';
import type { EntryPoint } from '../shared/entry-point.ts';
import type { EditorActiveTargetSnapshot } from '../shared/ipc-channels.ts';
import { promptForExistingFolder } from './dialog-helpers.ts';

export interface MenuDeps {
  /** `app.name` — the running app's name, used for the macOS App menu label. */
  appName: string;
  /**
   * Gates the View → Toggle Developer Tools item. When false, only that item is
   * omitted — Reload / Force Reload render unconditionally (all channels).
   * Caller decides; this module just renders.
   */
  showDevToolsMenu: boolean;
  /** `electron.dialog` — injected so the File → Open folder click handler
   *  can call `promptForExistingFolder(dialog)` without importing `dialog`
   *  at module scope (breaks Bun-test module load). */
  dialog: Dialog;
  /** Open the Project Navigator window (File → Switch project…). */
  openNavigator(): void;
  /**
   * Open a specific project folder (File → Open folder… or File → Recent project ▸ <row>).
   * `entryPoint` tags the originating menu surface so the consent-dialog gate
   * can branch on user intent.
   */
  openProject(projectPath: string, entryPoint: EntryPoint): Promise<void>;
  /** Current recent-projects list (top-of-LRU first). Used to build Recent project submenu. */
  getRecentProjects(): ReadonlyArray<{ path: string; name: string }>;
  /** Clear the recent-projects list (File → Recent project → Clear menu). */
  clearRecentProjects(): void;
  /** Open an external URL (Help menu). Injected so the `shell` runtime value doesn't cross the module boundary. */
  openExternalUrl(url: string): void;
  /**
   * Re-trigger the first-launch consent dialog from the File menu. Invoked
   * by "Set up OpenKnowledge integrations…" — a user who Skip'd
   * first-launch (or declined the shell-PATH toggle, or added a new editor
   * afterwards) can re-open the dialog without hand-deleting
   * `~/.ok/mcp-status.json`. The dialog covers both MCP wiring and the
   * PATH install. It opens immediately in the focused window (editor or
   * Navigator — the wiring is user-global, no project required); with zero
   * loaded windows it appears in the next window that opens. Gated on
   * darwin + `app.isPackaged`; `index.ts` short-circuits in dev +
   * non-darwin so the menu item is hidden there.
   */
  reconfigureMcpWiring?(): Promise<void> | void;
  /**
   * Help → Install in Claude Desktop… click handler. Navigates the focused
   * window's URL hash to `#install-claude-desktop` so App.tsx's
   * `InstallInClaudeDesktopTrigger` opens the dialog. Optional because the
   * menu renders even in contexts that don't wire it (unit tests).
   */
  openInstallSkillDialog?(): void;
  /**
   * Cmd-, "Settings…" click handler. Navigates the focused window's URL
   * hash to `#settings` so the renderer's `useSettingsRoute` hook (mounted
   * by `EditorArea`) renders the Settings pane in the main editor area.
   * Optional for the same reason as `openInstallSkillDialog` — unit tests
   * build the menu without wiring this.
   *
   * In Navigator window mode (the renderer is `NavigatorApp`, not `App`),
   * the hash change is a silent no-op since `useSettingsRoute` is not
   * mounted there — same precedent as `openInstallSkillDialog`.
   */
  openSettings?(): void;
  /**
   * Help → Report a Bug… click handler — fires the `report-bug` menu action
   * to the focused renderer, which opens the in-app report dialog (editor
   * windows and the Navigator both subscribe). Optional for the same reason
   * as `openInstallSkillDialog` — unit tests build the menu without wiring
   * it; the item itself always renders.
   */
  onReportBug?(): void;
  /**
   * "Check for updates…" click handler — fires an out-of-cadence
   * `autoUpdater.checkForUpdates()` via the `ok:update:check-now` IPC.
   * The user-facing result is delivered through the existing electron-
   * updater event toasts (update-available / update-not-available), so
   * the click handler returns void.
   *
   * Optional: `index.ts` only wires this when the updater handle has
   * booted successfully. When undefined, both the macOS App-menu entry
   * and the cross-platform Help-menu entry are omitted entirely (rather
   * than rendering disabled) — a disabled "Check for updates…" with no
   * tooltip explaining why is more confusing than absence in dev mode.
   */
  onCheckForUpdates?(): void;
  /**
   * macOS App menu → Uninstall OpenKnowledge… click handler. Optional so the
   * row is hidden in dev, non-packaged, non-macOS, or unsupported install
   * locations; the handler owns the destructive confirmation dialog.
   */
  onUninstall?(): void;
  /**
   * Active editor target snapshot — drives the macOS File menu's
   * state-aware item-management section. Renderer pushes this via
   * `ok:editor:active-target-changed` after each navigation; main calls
   * `installApplicationMenu` again on receipt so the menu's `enabled` /
   * `click` payload tracks the current target.
   *
   * `null` kind = project scope (no doc, folder, or asset selected); `doc`
   * / `folder` / `asset` carry the identifier the click handlers route
   * through the bridge.shell.* / HTTP path. Optional so unit tests can build
   * the menu without wiring a fake snapshot.
   */
  activeTarget?: EditorActiveTargetSnapshot;
  /**
   * File → New file click handler. Routes through the renderer-side
   * inline-rename flow at FileTree's startCreating helper — same path the
   * sidebar empty-space context menu uses. Optional because the menu is
   * also built in contexts that don't wire it (Bun unit tests).
   */
  onNewFile?(): void;
  /** File → New folder click handler. Sibling of `onNewFile`. */
  onNewFolder?(): void;
  /** File → New from Template… click handler — opens NewItemDialog. */
  onNewFromTemplate?(): void;
  /**
   * File → New project… click handler — opens the create-new-project
   * dialog in the focused window. Distinct from `openNavigator` (Switch
   * Project…, which lists/opens existing projects): this scaffolds a brand-new
   * project. Always enabled when wired (no `activeTarget` gate — creating a
   * project is project-scope-independent). Optional because the menu is also
   * built in contexts that don't wire it (Bun unit tests).
   */
  onNewProject?(): void;
  /**
   * File → New worktree… click handler (worktree = window). Delegates to
   * the focused renderer's ProjectSwitcher surface, which opens the create-
   * worktree dialog. Optional because the menu is also built in deps-unwired
   * unit-test contexts.
   */
  onNewWorktree?(): void;
  /**
   * File → Switch worktree… click handler. Opens the sidebar worktree switcher
   * in the focused renderer. Sibling of `onNewWorktree`.
   */
  onSwitchWorktree?(): void;
  /**
   * File → Rename click handler — invokes the renderer-side inline rename
   * for the current `activeTarget`. Enabled only when `activeTarget.kind`
   * is `'doc'`, `'folder'`, or `'asset'` (project scope has no target to rename).
   */
  onRename?(): void;
  /**
   * File → Duplicate click handler — invokes the renderer-side duplicate
   * flow for the current `activeTarget`. Enabled only when
   * `activeTarget.kind` is `'doc'` or `'folder'`.
   */
  onDuplicate?(): void;
  /**
   * File → Move to Trash click handler — invokes the 2-step
   * Trash flow on the current `activeTarget`. Enabled only when
   * `activeTarget.kind` is `'doc'`, `'folder'`, or `'asset'`. Cmd+Delete
   * accelerator matches Finder / VSCode convention.
   */
  onMoveToTrash?(): void;
  /**
   * File → Close tab click handler. The renderer consumes Cmd+W by closing
   * the active tab when one exists; when all tabs are already closed, it
   * falls back to closing the focused BrowserWindow. Every OK BrowserWindow
   * type must subscribe to `close-active-tab-or-window`; the main-process
   * menu cannot know whether the focused renderer has tabs.
   */
  onCloseActiveTabOrWindow?(): void;
  /**
   * File → Reveal in Finder click handler — invokes
   * `bridge.shell.showItemInFolder` against the current target (file/folder
   * absolute path; project scope reveals contentDir).
   */
  onRevealInFinder?(): void;
  /**
   * File → Open with AI > <agent> click handler — dispatches the existing
   * handoff flow against the current scope (file/folder/project) per the
   * sparkle icon's 3-way selector. Submenu construction happens in the
   * renderer; main fires this as a "open the submenu surface" trigger.
   */
  onSendToAi?(): void;
  /**
   * File → Copy path > Full path / Relative path click handlers — write
   * the absolute or project-relative path for the current target to the
   * system clipboard.
   */
  onCopyFullPath?(): void;
  onCopyRelativePath?(): void;
  /**
   * View menu visibility-toggle state. When undefined, each View-menu
   * Show … check item renders at its config-schema default. These mirror
   * the sidebar checkbox state — main reads the latest snapshot pushed
   * from the renderer (via the active-target push or a sibling
   * notification) so all surfaces (tree-options popover, sidebar context
   * menu, View menu) stay in sync.
   */
  showHiddenFilesChecked?: boolean;
  /** View → Show hidden files click handler — flips the projectLocalBinding flag. */
  onToggleShowHiddenFiles?(): void;
  showOkFoldersChecked?: boolean;
  /** View → Show .ok folders click handler — flips the projectLocalBinding flag. */
  onToggleShowOkFolders?(): void;
  showOnlyMarkdownFilesChecked?: boolean;
  /** View → Show only markdown files click handler — flips the projectLocalBinding flag. */
  onToggleShowOnlyMarkdownFiles?(): void;
  showSkillsSectionChecked?: boolean;
  /** View → Show skills section click handler — flips the projectLocalBinding flag. */
  onToggleShowSkillsSection?(): void;
  /**
   * Sidebar visibility — drives the View → Show/Hide sidebar item's label
   * (Apple HIG convention: single row whose label toggles based on current
   * state, matching Finder). `undefined` reads as "visible" so the item
   * renders "Hide sidebar" before the first renderer push lands. Sibling
   * of `showHiddenFilesChecked` — both flow from the same renderer-pushed
   * view-menu-state snapshot.
   */
  sidebarVisible?: boolean;
  /**
   * View → Show/Hide sidebar click handler — fires `ok:menu-action` with
   * action `'toggle-sidebar'` to the focused renderer, which calls
   * `useSidebar().toggleSidebar()`. The ⌥⌘S accelerator (Apple HIG sidebar
   * convention; ⌘B is Bold in the editor) is OS-captured: Electron routes
   * the keypress to this menu item before it reaches the renderer.
   */
  onToggleSidebar?(): void;
  docPanelVisible?: boolean;
  onToggleDocPanel?(): void;
  /**
   * Docked terminal-panel visibility — drives the View → Show/Hide Terminal
   * label. Unlike the sidebar/doc-panel (visible by default), the terminal
   * starts hidden, so `undefined`/`false` reads as "Show Terminal".
   */
  terminalVisible?: boolean;
  onToggleTerminal?(): void;
  /**
   * Top-level Terminal menu actions. `onNewTerminal` opens a new terminal tab
   * (revealing the dock if hidden; it never hides an already-open terminal,
   * unlike the View toggle). `onKillTerminal` closes the active tab — killing
   * that session's PTY and collapsing the dock only when it was the last tab.
   * Both optional because the menu is also built in deps-unwired unit-test contexts.
   */
  onNewTerminal?(): void;
  onKillTerminal?(): void;
  /**
   * Opens a new dedicated terminal WINDOW (distinct from `onNewTerminal`, which
   * opens a tab in the docked panel). Main resolves the focused window's project
   * and opens the window directly — no renderer round-trip. Optional for the
   * deps-unwired unit-test contexts.
   */
  onNewTerminalWindow?(): void;
  /**
   * Whether a terminal session is live (mounted). Gates "Kill Terminal" — a
   * collapsed-but-alive terminal still counts as live, so this tracks the dock
   * latch, not visibility. `undefined`/`false` keeps Kill Terminal disabled.
   */
  terminalLive?: boolean;
  /**
   * Smart-hide signals for the View → Expand all / Collapse all items.
   * When `canExpandAll === false`, every folder tree-wide is already
   * expanded — hide Expand all. When `canCollapseAll === false`, every
   * folder is already collapsed — hide Collapse all. undefined treats as
   * "can perform" so the items render in deps-unwired unit-test contexts.
   */
  canExpandAll?: boolean;
  canCollapseAll?: boolean;
  /** View → Expand all click handler — tree-scoped (sibling of sidebar Expand all). */
  onExpandAll?(): void;
  /** View → Collapse all click handler — tree-scoped. */
  onCollapseAll?(): void;
  /**
   * App-wide spell-check flag — drives the Edit menu's "Check spelling while
   * typing" checkbox (why one app-level flag: see `AppState.spellCheckEnabled`
   * in state-store.ts). Defaults to checked when unwired, matching the
   * on-by-default persistence default, so the menu reads correctly before the
   * flag is plumbed.
   */
  spellCheckEnabled?: boolean;
  /**
   * Edit → "Check spelling while typing" click handler. Flips the app-wide flag
   * (live session toggle + persist) then rebuilds the menu so the checkmark
   * tracks the new state. Shares the persisted flag with the in-editor context
   * menu's Disable/Enable rows. Optional because the menu is also built in
   * contexts that don't wire it (unit tests).
   */
  onToggleSpellCheck?(): void;
}

/**
 * Install the template as the application menu. Dynamically imports
 * `Menu` so the module-top scope stays Bun-test-loadable; callers must
 * be in an async context (typically `app.whenReady().then(async () => ...)`).
 */
export async function installApplicationMenu(deps: MenuDeps): Promise<void> {
  const { Menu } = await import('electron');
  const template = buildMenuTemplate(deps);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Desktop-side binding for each command identity: how the native menu derives a
 * leaf's click / enabled / presence / checkbox state from the injected
 * `MenuDeps`. This is the "click handlers stay wired by id" layer — a leaf's
 * label, accelerator, placement, and availability all come from the shared
 * registry (`@inkeep/open-knowledge-core`), and only this desktop glue lives
 * here.
 *
 * `enabled` is the dep-presence gate ANDed with the registry availability (an
 * unwired dep disables the leaf — the unit-test-safe behavior the menu has
 * always had; in production every dep is wired, so availability drives it).
 * `present` omits the leaf entirely — capability/flag-gated items that render as
 * absence, not disabled. Both default to "always".
 */
interface MenuCommandBinding {
  click?(deps: MenuDeps): MenuItemConstructorOptions['click'];
  enabled?(deps: MenuDeps): boolean;
  present?(deps: MenuDeps): boolean;
  checked?(deps: MenuDeps): boolean;
}

const MENU_BINDINGS: Record<string, MenuCommandBinding> = {
  'new-file': { click: (d) => () => d.onNewFile?.(), enabled: (d) => d.onNewFile !== undefined },
  'new-folder': {
    click: (d) => () => d.onNewFolder?.(),
    enabled: (d) => d.onNewFolder !== undefined,
  },
  'new-from-template': {
    click: (d) => () => d.onNewFromTemplate?.(),
    enabled: (d) => d.onNewFromTemplate !== undefined,
  },
  'new-project': {
    click: (d) => () => d.onNewProject?.(),
    enabled: (d) => d.onNewProject !== undefined,
  },
  // Switch project / Open folder are always enabled — their deps are required.
  'switch-project': { click: (d) => () => d.openNavigator() },
  'open-folder': {
    click: (d) => async () => {
      // Shared with the `ok:dialog:open-folder` IPC handler so both call sites
      // agree on dialog options forever — see dialog-helpers.
      const picked = await promptForExistingFolder(d.dialog);
      if (picked) {
        await d.openProject(picked, 'pick-existing');
      }
    },
  },
  'new-worktree': {
    click: (d) => () => d.onNewWorktree?.(),
    enabled: (d) => d.onNewWorktree !== undefined,
  },
  'switch-worktree': {
    click: (d) => () => d.onSwitchWorktree?.(),
    enabled: (d) => d.onSwitchWorktree !== undefined,
  },
  duplicate: { click: (d) => () => d.onDuplicate?.(), enabled: (d) => d.onDuplicate !== undefined },
  rename: { click: (d) => () => d.onRename?.(), enabled: (d) => d.onRename !== undefined },
  'move-to-trash': {
    click: (d) => () => d.onMoveToTrash?.(),
    enabled: (d) => d.onMoveToTrash !== undefined,
  },
  'reveal-in-finder': {
    click: (d) => () => d.onRevealInFinder?.(),
    enabled: (d) => d.onRevealInFinder !== undefined,
  },
  'send-to-ai': {
    click: (d) => () => d.onSendToAi?.(),
    enabled: (d) => d.onSendToAi !== undefined,
  },
  'copy-full-path': {
    click: (d) => () => d.onCopyFullPath?.(),
    enabled: (d) => d.onCopyFullPath !== undefined,
  },
  'copy-relative-path': {
    click: (d) => () => d.onCopyRelativePath?.(),
    enabled: (d) => d.onCopyRelativePath !== undefined,
  },
  // Re-trigger first-launch MCP consent. Presence-gated: non-macOS / non-packaged
  // contexts (where MCP wiring no-ops anyway) plumb `undefined` and hide the row.
  'set-up-integrations': {
    click: (d) => () => {
      void d.reconfigureMcpWiring?.();
    },
    present: (d) => d.reconfigureMcpWiring !== undefined,
  },
  settings: { click: (d) => () => d.openSettings?.() },
  'close-tab': {
    click: (d) => () => d.onCloseActiveTabOrWindow?.(),
    enabled: (d) => d.onCloseActiveTabOrWindow !== undefined,
  },
  // Presence-gated on the booted updater handle; a bare click reference matches
  // the runtime shape Electron invokes for a shortcut-less item.
  'check-for-updates': {
    click: (d) => d.onCheckForUpdates,
    present: (d) => d.onCheckForUpdates !== undefined,
  },
  uninstall: { click: (d) => () => d.onUninstall?.(), present: (d) => d.onUninstall !== undefined },
  'new-terminal': {
    click: (d) => () => d.onNewTerminal?.(),
    enabled: (d) => d.onNewTerminal !== undefined,
  },
  'new-terminal-window': {
    click: (d) => () => d.onNewTerminalWindow?.(),
    enabled: (d) => d.onNewTerminalWindow !== undefined,
  },
  'kill-terminal': {
    click: (d) => () => d.onKillTerminal?.(),
    enabled: (d) => d.onKillTerminal !== undefined,
  },
  'toggle-spell-check': {
    click: (d) => () => d.onToggleSpellCheck?.(),
    enabled: (d) => d.onToggleSpellCheck !== undefined,
    checked: (d) => d.spellCheckEnabled ?? true,
  },
  'toggle-sidebar': {
    click: (d) => () => d.onToggleSidebar?.(),
    enabled: (d) => d.onToggleSidebar !== undefined,
  },
  'toggle-doc-panel': {
    click: (d) => () => d.onToggleDocPanel?.(),
    enabled: (d) => d.onToggleDocPanel !== undefined,
  },
  'toggle-terminal': {
    click: (d) => () => d.onToggleTerminal?.(),
    enabled: (d) => d.onToggleTerminal !== undefined,
  },
  'toggle-show-hidden-files': {
    click: (d) => () => d.onToggleShowHiddenFiles?.(),
    enabled: (d) => d.onToggleShowHiddenFiles !== undefined,
    checked: (d) => d.showHiddenFilesChecked ?? false,
  },
  'toggle-show-ok-folders': {
    click: (d) => () => d.onToggleShowOkFolders?.(),
    enabled: (d) => d.onToggleShowOkFolders !== undefined,
    checked: (d) => d.showOkFoldersChecked ?? false,
  },
  'toggle-show-only-markdown-files': {
    click: (d) => () => d.onToggleShowOnlyMarkdownFiles?.(),
    enabled: (d) => d.onToggleShowOnlyMarkdownFiles !== undefined,
    checked: (d) => d.showOnlyMarkdownFilesChecked ?? false,
  },
  'toggle-show-skills-section': {
    click: (d) => () => d.onToggleShowSkillsSection?.(),
    enabled: (d) => d.onToggleShowSkillsSection !== undefined,
    // Skills section is default-on, so the unwired checkbox reads checked.
    checked: (d) => d.showSkillsSectionChecked ?? true,
  },
  'expand-all-tree': {
    click: (d) => () => d.onExpandAll?.(),
    enabled: (d) => d.onExpandAll !== undefined,
  },
  'collapse-all-tree': {
    click: (d) => () => d.onCollapseAll?.(),
    enabled: (d) => d.onCollapseAll !== undefined,
  },
  'open-github': { click: (d) => () => d.openExternalUrl(OPEN_KNOWLEDGE_GITHUB_URL) },
  // Report a Bug always renders + is enabled; the click no-ops when unwired.
  'report-bug': { click: (d) => () => d.onReportBug?.() },
  'install-claude-desktop': {
    click: (d) => () => d.openInstallSkillDialog?.(),
    present: () => SHOW_INSTALL_SKILL,
  },
};

/**
 * The command ids that carry a desktop binding. Exported so the parity ratchet
 * can assert every menu-placed registry command has one: a command with a `menu`
 * placement but no binding would render a leaf with no click handler, enabled by
 * default — a silent no-op the optional-chained lookup in `buildCommandLeaves`
 * would not catch.
 */
export const MENU_BINDING_IDS: ReadonlySet<string> = new Set(Object.keys(MENU_BINDINGS));

/** Project the pushed active-target snapshot onto the shared gating kind. The
 *  menu maps project scope (and the pre-first-push `undefined`) to `project`:
 *  contentDir is still an actionable target, so reveal / copy-path stay enabled
 *  there, while rename / duplicate / trash (which require a real file) do not. */
function menuTargetKind(target: EditorActiveTargetSnapshot | undefined): ContextualTargetKind {
  if (target === undefined || target.kind === null) return 'project';
  return target.kind;
}

function menuCommandContext(deps: MenuDeps): CommandContext {
  return {
    host: 'desktop',
    activeTargetKind: menuTargetKind(deps.activeTarget),
    // The native menu has no single-file concept; those commands never gate here.
    singleFile: false,
    terminalLive: deps.terminalLive === true,
    canExpandAll: deps.canExpandAll ?? true,
    canCollapseAll: deps.canCollapseAll ?? true,
    // No Open-graph leaf in the menu; the field is palette-only.
    hasActiveDoc: false,
    showInstallSkill: SHOW_INSTALL_SKILL,
  };
}

/** Resolve a menu leaf's plain-string label: an explicit literal, the Show/Hide
 *  toggle variant driven by the pushed view-menu-state, a per-placement key
 *  override (Copy path's children), or the command's own `labelKey`. */
function menuLeafLabel(
  cmd: CommandIdentity,
  placement: CommandMenuPlacement,
  deps: MenuDeps,
): string {
  if (placement.menuLabelText !== undefined) return placement.menuLabelText;
  if (cmd.stateToggle) {
    const { stateField, defaultVisible, showKey, hideKey } = cmd.stateToggle;
    const visible = deps[stateField] ?? defaultVisible;
    return MENU_LABELS[visible ? hideKey : showKey];
  }
  const key = placement.menuLabelKey ?? cmd.labelKey;
  if (key === undefined) {
    throw new Error(`command ${cmd.id} menu leaf has no resolvable label`);
  }
  return MENU_LABELS[key];
}

/** Generate the actionable command leaves for the current platform, grouped by
 *  their declared menu section. `buildMenuTemplate` slots each group into the
 *  declarative scaffolding (roles / separators / submenu parents / recents). */
function buildCommandLeaves(
  deps: MenuDeps,
  isMac: boolean,
): Map<MenuSection, MenuItemConstructorOptions[]> {
  const platform = isMac ? 'mac' : 'other';
  const ctx = menuCommandContext(deps);
  const staged = new Map<MenuSection, Array<{ order: number; item: MenuItemConstructorOptions }>>();
  for (const cmd of COMMAND_IDENTITIES) {
    if (!cmd.menu) continue;
    const binding = MENU_BINDINGS[cmd.id];
    for (const placement of cmd.menu) {
      const plat = placement.platform ?? 'all';
      if (plat !== 'all' && plat !== platform) continue;
      if (binding?.present && !binding.present(deps)) continue;
      const available = evaluateCommandAvailability(cmd.availability, ctx);
      const depWired = binding?.enabled ? binding.enabled(deps) : true;
      const label = menuLeafLabel(cmd, placement, deps);
      const item: MenuItemConstructorOptions = {
        label: placement.ellipsis ? `${label}…` : label,
      };
      const click = binding?.click?.(deps);
      if (click !== undefined) item.click = click;
      if (placement.accelerator !== undefined) item.accelerator = placement.accelerator;
      if (placement.checkbox === true) {
        item.type = 'checkbox';
        item.checked = binding?.checked ? binding.checked(deps) : false;
      }
      if (placement.smartHide === true) {
        // Smart-hide (Expand/Collapse all): availability maps to `visible`, so a
        // fully-expanded tree hides the no-op affordance rather than disabling it.
        item.visible = available;
        item.enabled = depWired;
      } else {
        item.enabled = available && depWired;
      }
      const list = staged.get(placement.section) ?? [];
      list.push({ order: placement.order, item });
      staged.set(placement.section, list);
    }
  }
  const result = new Map<MenuSection, MenuItemConstructorOptions[]>();
  for (const [section, entries] of staged) {
    entries.sort((a, b) => a.order - b.order);
    result.set(
      section,
      entries.map((e) => e.item),
    );
  }
  return result;
}

/** Append a trailing separator iff the section rendered any leaves (so a
 *  presence-gated section contributes neither leaf nor stray separator). */
function withTrailingSep(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.length > 0 ? [...items, { type: 'separator' as const }] : [];
}

/** Prepend a leading separator iff the section rendered any leaves. */
function withLeadingSep(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.length > 0 ? [{ type: 'separator' as const }, ...items] : [];
}

/**
 * Exported for unit testing — pure function over deps. The actionable command
 * leaves are generated from the shared registry (`buildCommandLeaves`); the
 * roles, separators, submenu parents (Recent project, Copy path), the dynamic
 * recents rows, and the `isMac` platform branches stay declarative here.
 */
export function buildMenuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';
  const recents = deps.getRecentProjects();
  const leaves = buildCommandLeaves(deps, isMac);
  const leafOf = (section: MenuSection): MenuItemConstructorOptions[] => leaves.get(section) ?? [];

  const recentSubmenu: MenuItemConstructorOptions[] =
    recents.length === 0
      ? [{ label: 'No recent projects', enabled: false }]
      : [
          ...recents.slice(0, 10).map((row) => ({
            label: row.name,
            sublabel: row.path,
            click: () => {
              void deps.openProject(row.path, 'recents');
            },
          })),
          { type: 'separator' as const },
          {
            label: 'Clear menu',
            click: () => deps.clearRecentProjects(),
          },
        ];

  const template: MenuItemConstructorOptions[] = [
    // macOS application menu (auto-populated with the app name).
    ...(isMac
      ? [
          {
            label: deps.appName,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              // Apple HIG: "Check for updates…" under About, then "Settings…".
              // Both are platform-conditional placements in the shared registry
              // (the App-menu placement is `mac`-only; each has a mirror `other`
              // placement in the File / Help menu), so the leaf renders exactly
              // once per platform — the previously hand-branched dedupe, now
              // expressed as data.
              ...withTrailingSep(leafOf('app-updates')),
              ...leafOf('app-settings'),
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              ...withTrailingSep(leafOf('app-uninstall')),
              { role: 'quit' as const },
            ],
          },
        ]
      : []),

    {
      label: 'File',
      submenu: [
        // Creation items head the File menu; then the project section (mirrors
        // the in-app ProjectSwitcher order: Recent → New project → Switch →
        // Open folder); then worktrees; then the activeTarget-gated
        // item-management actions; then reveal / AI / copy-path. Every command
        // leaf comes from the registry — the separators, the Recent-project
        // submenu, and the Copy-path submenu parent stay declarative here.
        ...leafOf('file-create'),
        { type: 'separator' },
        {
          label: 'Recent project',
          submenu: recentSubmenu,
        },
        ...leafOf('file-project'),
        { type: 'separator' },
        ...leafOf('file-worktree'),
        { type: 'separator' },
        ...leafOf('file-item'),
        { type: 'separator' },
        ...leafOf('file-reveal'),
        {
          label: MENU_LABELS.copyPath,
          enabled: deps.onCopyFullPath !== undefined || deps.onCopyRelativePath !== undefined,
          submenu: leafOf('file-copy-path'),
        },
        { type: 'separator' },
        ...withTrailingSep(leafOf('file-integrations')),
        // On Windows/Linux Settings… belongs in the File menu (macOS renders it
        // in the App menu above); its registry placement is `other`-only.
        ...withTrailingSep(leafOf('file-settings')),
        ...(isMac ? leafOf('file-close') : [{ role: 'quit' as const }]),
      ],
    },

    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        ...leafOf('edit-spell'),
      ],
    },

    {
      label: 'View',
      submenu: [
        // Reload / Force Reload ship on every channel; Toggle Developer Tools is
        // gated on `showDevToolsMenu` (dev + beta) — Electron built-in roles.
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        ...(deps.showDevToolsMenu
          ? ([{ role: 'toggleDevTools' as const }] satisfies MenuItemConstructorOptions[])
          : []),
        { type: 'separator' as const },
        ...leafOf('view-panels'),
        { type: 'separator' },
        ...leafOf('view-visibility'),
        { type: 'separator' },
        ...leafOf('view-tree'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    {
      // Top-level Terminal menu (VS Code placement, between View and Window).
      label: 'Terminal',
      submenu: leafOf('terminal'),
    },

    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        ...(isMac
          ? ([
              { role: 'zoom' as const },
              { type: 'separator' as const },
              { role: 'front' as const },
            ] satisfies MenuItemConstructorOptions[])
          : ([{ role: 'close' as const }] satisfies MenuItemConstructorOptions[])),
      ],
    },

    {
      label: 'Help',
      submenu: [
        ...withTrailingSep(leafOf('help-install')),
        ...leafOf('help-links'),
        // macOS gets the Apple-HIG App-menu placement above; Windows/Linux have
        // no application menu, so Help is the convention there (leading sep).
        ...withLeadingSep(leafOf('help-updates')),
      ],
    },
  ];

  return template;
}
