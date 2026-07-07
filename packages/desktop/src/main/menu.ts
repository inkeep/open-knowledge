/**
 * Application menu — baseline.
 *
 * Covers the File / Edit / View / Window scope:
 *   - File: Switch project (open Navigator), Open folder (native picker),
 *     Recent project submenu, Close Window
 *   - Edit: macOS defaults (Undo/Redo/Cut/Copy/Paste/Select All)
 *   - View: zoom / fullscreen always; Reload / Force Reload / Toggle DevTools
 *     gated on `showDevToolsMenu` (dev + beta only) — Electron built-in roles
 *   - Window: macOS defaults (Minimize / Zoom / Bring to Front)
 *
 * Deferred to later work:
 *   - Project menu (Save Version, Version History, Reveal .ok/, Trust Project)
 *   - File → Clone from GitHub…
 *   - View → Graph / Timeline / Backlinks / Outline toggles
 *   - Help menu (Documentation, Report Issue, Check for updates)
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

import { MENU_LABELS, SHOW_INSTALL_SKILL } from '@inkeep/open-knowledge-core';
import type { Dialog, MenuItemConstructorOptions } from 'electron';
import type { EntryPoint } from '../shared/entry-point.ts';
import type { EditorActiveTargetSnapshot } from '../shared/ipc-channels.ts';
import { SWITCH_PROJECT_LABEL_WITH_ELLIPSIS } from '../shared/labels.ts';
import { promptForExistingFolder } from './dialog-helpers.ts';

export interface MenuDeps {
  /** `app.name` — the running app's name, used for the macOS App menu label. */
  appName: string;
  /**
   * Gates the View → Reload / Force Reload / Toggle Developer Tools cluster.
   * When false, all three are omitted. Caller decides; this module just renders.
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
   * View menu visibility-toggle state. When undefined, the View-menu
   * Show … check items render unchecked. These mirror the sidebar checkbox
   * state — main reads the latest snapshot pushed from the renderer (via
   * the active-target push or a sibling notification) so both surfaces
   * (sidebar context menu, View menu) stay in sync.
   */
  showHiddenFilesChecked?: boolean;
  /** View → Show hidden files click handler — flips the projectLocalBinding flag. */
  onToggleShowHiddenFiles?(): void;
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

/** Exported for unit testing — pure function over deps. */
export function buildMenuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';
  const recents = deps.getRecentProjects();

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
              // Apple HIG canonical placement: "Check for updates…"
              // immediately under About in the application menu. Hidden
              // when the updater handle isn't available (dev mode, boot
              // failure) — see MenuDeps.onCheckForUpdates rationale.
              ...(deps.onCheckForUpdates
                ? ([
                    {
                      label: 'Check for updates…',
                      click: deps.onCheckForUpdates,
                    },
                    { type: 'separator' as const },
                  ] satisfies MenuItemConstructorOptions[])
                : []),
              // Apple HIG places "Settings…" / "Preferences…" immediately
              // before the services group. The CmdOrCtrl+, accelerator is
              // OS-captured: Electron routes the keypress to this menu
              // item before it reaches the renderer's keydown handler.
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => deps.openSettings?.(),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),

    {
      label: 'File',
      submenu: [
        // Creation items head the File menu (New file / New folder / New from
        // template), then the project section, then the item-management actions
        // (Duplicate / Rename / Move to Trash). Each item-management action is
        // enable/disabled per `activeTarget` so a project-scope window doesn't
        // surface Rename / Duplicate / Move to Trash with no target; asset scope
        // enables Rename / Move to Trash but keeps Duplicate disabled.
        {
          label: MENU_LABELS.newFile,
          accelerator: 'CmdOrCtrl+N',
          enabled: deps.onNewFile !== undefined,
          click: () => deps.onNewFile?.(),
        },
        {
          label: MENU_LABELS.newFolder,
          accelerator: 'CmdOrCtrl+Shift+N',
          enabled: deps.onNewFolder !== undefined,
          click: () => deps.onNewFolder?.(),
        },
        {
          label: `${MENU_LABELS.newFromTemplate}\u2026`,
          enabled: deps.onNewFromTemplate !== undefined,
          click: () => deps.onNewFromTemplate?.(),
        },
        { type: 'separator' },
        // Project section — order mirrors the in-app ProjectSwitcher
        // (packages/app/src/components/ProjectSwitcher.tsx) so the native menu
        // and the sidebar footer read identically. The recents submenu and the
        // create / switch / open wiring are unchanged; only position, order,
        // and labels moved here.
        {
          label: 'Recent project',
          submenu: recentSubmenu,
        },
        {
          // Scaffolds a brand-new project (opens the create-new-project dialog).
          // No `activeTarget` gate — creating a project doesn't depend on scope.
          label: `${MENU_LABELS.newProject}\u2026`,
          enabled: deps.onNewProject !== undefined,
          click: () => deps.onNewProject?.(),
        },
        {
          label: SWITCH_PROJECT_LABEL_WITH_ELLIPSIS,
          // Rebound from Cmd+Shift+N (now New folder) to Cmd+Shift+P per macOS
          // HIG for navigation/palette-style commands.
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => deps.openNavigator(),
        },
        {
          label: `${MENU_LABELS.openFolder}\u2026`,
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            // Shared with the `ok:dialog:open-folder` IPC handler so both call
            // sites agree on dialog options forever — see dialog-helpers.
            const picked = await promptForExistingFolder(deps.dialog);
            if (picked) {
              await deps.openProject(picked, 'pick-existing');
            }
          },
        },
        { type: 'separator' },
        // Worktree selector (worktree = window). Mirrors the sidebar
        // ProjectSwitcher's worktree section — both delegate to the same
        // renderer surface. Disabled (not hidden) in the Navigator window and
        // in unit-test contexts, where the deps aren't wired.
        {
          label: 'New worktree…',
          enabled: deps.onNewWorktree !== undefined,
          click: () => deps.onNewWorktree?.(),
        },
        {
          label: 'Switch worktree…',
          enabled: deps.onSwitchWorktree !== undefined,
          click: () => deps.onSwitchWorktree?.(),
        },
        { type: 'separator' },
        {
          label: MENU_LABELS.duplicate,
          accelerator: 'CmdOrCtrl+D',
          enabled:
            deps.onDuplicate !== undefined &&
            deps.activeTarget !== undefined &&
            (deps.activeTarget.kind === 'doc' || deps.activeTarget.kind === 'folder'),
          click: () => deps.onDuplicate?.(),
        },
        {
          label: MENU_LABELS.rename,
          // Project scope (kind === null) has no target to rename \u2192 disabled.
          enabled:
            deps.onRename !== undefined &&
            deps.activeTarget !== undefined &&
            deps.activeTarget.kind !== null,
          click: () => deps.onRename?.(),
        },
        {
          label: 'Move to Trash',
          accelerator: 'CmdOrCtrl+Delete',
          enabled:
            deps.onMoveToTrash !== undefined &&
            deps.activeTarget !== undefined &&
            deps.activeTarget.kind !== null,
          click: () => deps.onMoveToTrash?.(),
        },
        { type: 'separator' },
        {
          label: MENU_LABELS.revealInFinder,
          enabled: deps.onRevealInFinder !== undefined,
          click: () => deps.onRevealInFinder?.(),
        },
        {
          label: MENU_LABELS.openWithAi,
          enabled: deps.onSendToAi !== undefined && deps.activeTarget?.kind !== 'asset',
          click: () => deps.onSendToAi?.(),
        },
        {
          label: MENU_LABELS.copyPath,
          enabled: deps.onCopyFullPath !== undefined || deps.onCopyRelativePath !== undefined,
          submenu: [
            {
              label: MENU_LABELS.fullPath,
              enabled: deps.onCopyFullPath !== undefined,
              click: () => deps.onCopyFullPath?.(),
            },
            {
              label: MENU_LABELS.relativePath,
              enabled: deps.onCopyRelativePath !== undefined,
              click: () => deps.onCopyRelativePath?.(),
            },
          ],
        },
        { type: 'separator' },
        // Re-trigger first-launch MCP consent. The dep is optional so
        // non-macOS / non-packaged contexts (where MCP wiring no-ops
        // anyway) hide the row. `deps`
        // plumbs `undefined` when the runtime has nothing to offer.
        ...(deps.reconfigureMcpWiring
          ? ([
              {
                label: 'Set up OpenKnowledge integrations…',
                click: () => {
                  void deps.reconfigureMcpWiring?.();
                },
              },
              { type: 'separator' as const },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        // On Windows/Linux Settings… belongs in the File menu (Apple
        // HIG only governs macOS; on macOS the Settings entry lives in the
        // App menu above). Placed above the trailing close/quit role.
        ...(!isMac
          ? ([
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => deps.openSettings?.(),
              },
              { type: 'separator' as const },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        isMac
          ? {
              label: 'Close tab',
              accelerator: 'CmdOrCtrl+W',
              enabled: deps.onCloseActiveTabOrWindow !== undefined,
              click: () => deps.onCloseActiveTabOrWindow?.(),
            }
          : { role: 'quit' },
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
        // macOS Edit-menu spell-check toggle. `checked` is derived from the
        // persisted app-wide flag at build time; toggling (here or from the
        // in-editor context menu) rebuilds the menu so the checkmark stays in
        // sync. No accelerator — macOS has no canonical one for this item.
        {
          label: 'Check spelling while typing',
          type: 'checkbox',
          checked: deps.spellCheckEnabled ?? true,
          enabled: deps.onToggleSpellCheck !== undefined,
          click: () => deps.onToggleSpellCheck?.(),
        },
      ],
    },

    {
      label: 'View',
      submenu: [
        ...(deps.showDevToolsMenu
          ? ([
              { role: 'reload' as const },
              { role: 'forceReload' as const },
              { role: 'toggleDevTools' as const },
              { type: 'separator' as const },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        // Sidebar visibility toggle. Apple HIG convention: a single row whose
        // label flips between "Show sidebar" / "Hide sidebar" based on the
        // current state (Finder's pattern), rather than a checkbox row. ⌥⌘S
        // is Apple's canonical accelerator for sidebar toggle — ⌘B is Bold in
        // the TipTap editor, and ⌘\ is non-standard. Spelled `CmdOrCtrl+Alt+S`
        // (not `Option+Cmd+S`): Electron renders `Alt` as ⌥ and `CmdOrCtrl` as
        // ⌘ on macOS, so this is the identical ⌥⌘S here while staying the
        // cross-platform-safe form the sibling accelerators use. The accelerator
        // is OS-captured: Electron routes the keypress to this menu item before
        // it reaches the renderer's keydown handler, so the renderer's
        // shadcn sidebar primitive does NOT also bind a window keydown.
        {
          label: deps.sidebarVisible === false ? 'Show sidebar' : 'Hide sidebar',
          accelerator: 'CmdOrCtrl+Alt+S',
          enabled: deps.onToggleSidebar !== undefined,
          click: () => deps.onToggleSidebar?.(),
        },
        {
          label: deps.docPanelVisible === false ? 'Show document panel' : 'Hide document panel',
          accelerator: 'CmdOrCtrl+Alt+B',
          enabled: deps.onToggleDocPanel !== undefined,
          click: () => deps.onToggleDocPanel?.(),
        },
        {
          // Terminal starts hidden, so falsy/undefined reads "Show Terminal".
          // ⌘J / Ctrl+J is OS-captured (fires before the renderer), so a
          // focused xterm can't swallow it — same model as the sidebar item.
          label: deps.terminalVisible ? 'Hide Terminal' : 'Show Terminal',
          accelerator: 'CmdOrCtrl+J',
          enabled: deps.onToggleTerminal !== undefined,
          click: () => deps.onToggleTerminal?.(),
        },
        { type: 'separator' },
        // File-display visibility toggle. Checkbox state mirrors the sidebar's
        // empty-space + folder menu items. Toggling here flips the
        // projectLocalBinding flag via the renderer's menu-action handler;
        // the resulting CRDT write propagates back through merged config so
        // both surfaces (sidebar + View menu) stay in sync.
        {
          label: MENU_LABELS.showHiddenFiles,
          accelerator: 'CmdOrCtrl+Shift+.',
          type: 'checkbox',
          checked: deps.showHiddenFilesChecked ?? false,
          enabled: deps.onToggleShowHiddenFiles !== undefined,
          click: () => deps.onToggleShowHiddenFiles?.(),
        },
        { type: 'separator' },
        // Tree-scoped Expand/Collapse all. Smart-hide via `visible: false`
        // (rather than `enabled: false`) so a fully-expanded tree doesn't
        // render a useless enabled-with-no-op Expand all affordance.
        {
          label: MENU_LABELS.expandAll,
          visible: deps.canExpandAll ?? true,
          enabled: deps.onExpandAll !== undefined,
          click: () => deps.onExpandAll?.(),
        },
        {
          label: MENU_LABELS.collapseAll,
          visible: deps.canCollapseAll ?? true,
          enabled: deps.onCollapseAll !== undefined,
          click: () => deps.onCollapseAll?.(),
        },
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
      // The discoverable home for terminal actions; the View → Show/Hide
      // Terminal toggle stays as-is to keep the established ⌘J muscle memory.
      label: 'Terminal',
      submenu: [
        {
          // Opens a new terminal tab each click (revealing the dock if hidden;
          // never hides). No accelerator here: ⌘J belongs to the View →
          // Show/Hide Terminal toggle, and advertising the same key on two
          // items only mislabels this one — the OS does not guarantee which
          // item a duplicate accelerator dispatches to.
          label: 'New Terminal',
          enabled: deps.onNewTerminal !== undefined,
          click: () => deps.onNewTerminal?.(),
        },
        {
          // Opens a dedicated terminal window (1:1 with VS Code's "New Terminal
          // Window"). No accelerator — VS Code ships the command unbound, and
          // ⌘J stays the docked Show/Hide Terminal toggle.
          label: 'New Terminal Window',
          enabled: deps.onNewTerminalWindow !== undefined,
          click: () => deps.onNewTerminalWindow?.(),
        },
        {
          // Closes the active tab — kills its shell (not just hide). Enabled
          // only when at least one session is live; a collapsed-but-alive
          // terminal still qualifies.
          label: 'Kill Terminal',
          enabled: deps.onKillTerminal !== undefined && deps.terminalLive === true,
          click: () => deps.onKillTerminal?.(),
        },
      ],
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
        ...(SHOW_INSTALL_SKILL
          ? ([
              {
                label: 'Install for Claude Chat & Cowork (desktop app)…',
                click: () => deps.openInstallSkillDialog?.(),
              },
              { type: 'separator' as const },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        {
          label: 'OpenKnowledge on GitHub',
          click: () => deps.openExternalUrl('https://github.com/inkeep/open-knowledge'),
        },
        // Cross-platform "Check for updates…" — Windows/Linux convention
        // is to place this in Help, since those platforms have no
        // application menu. macOS users get the Apple-HIG-canonical
        // placement under the App menu instead, but the Help entry is
        // also kept for discoverability (mirrors VS Code, Slack, etc.).
        ...(deps.onCheckForUpdates
          ? ([
              { type: 'separator' as const },
              {
                label: 'Check for updates…',
                click: deps.onCheckForUpdates,
              },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
  ];

  return template;
}
