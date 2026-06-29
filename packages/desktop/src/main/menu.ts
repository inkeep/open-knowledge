
import { MENU_LABELS, SHOW_INSTALL_SKILL } from '@inkeep/open-knowledge-core';
import type { Dialog, MenuItemConstructorOptions } from 'electron';
import type { EntryPoint } from '../shared/entry-point.ts';
import type { EditorActiveTargetSnapshot } from '../shared/ipc-channels.ts';
import { SWITCH_PROJECT_LABEL_WITH_ELLIPSIS } from '../shared/labels.ts';
import { promptForExistingFolder } from './dialog-helpers.ts';

export interface MenuDeps {
  appName: string;
  showDevToolsMenu: boolean;
  /** `electron.dialog` — injected so the File → Open folder click handler
   *  can call `promptForExistingFolder(dialog)` without importing `dialog`
   *  at module scope (breaks Bun-test module load; see file header). */
  dialog: Dialog;
  openNavigator(): void;
  openProject(projectPath: string, entryPoint: EntryPoint): Promise<void>;
  getRecentProjects(): ReadonlyArray<{ path: string; name: string }>;
  clearRecentProjects(): void;
  openExternalUrl(url: string): void;
  reconfigureMcpWiring?(): Promise<void> | void;
  openInstallSkillDialog?(): void;
  openSettings?(): void;
  onCheckForUpdates?(): void;
  activeTarget?: EditorActiveTargetSnapshot;
  onNewFile?(): void;
  onNewFolder?(): void;
  onNewFromTemplate?(): void;
  onNewProject?(): void;
  onRename?(): void;
  onDuplicate?(): void;
  onMoveToTrash?(): void;
  onCloseActiveTabOrWindow?(): void;
  onRevealInFinder?(): void;
  onSendToAi?(): void;
  onCopyFullPath?(): void;
  onCopyRelativePath?(): void;
  showHiddenFilesChecked?: boolean;
  onToggleShowHiddenFiles?(): void;
  sidebarVisible?: boolean;
  onToggleSidebar?(): void;
  docPanelVisible?: boolean;
  onToggleDocPanel?(): void;
  terminalVisible?: boolean;
  onToggleTerminal?(): void;
  onNewTerminal?(): void;
  onKillTerminal?(): void;
  terminalLive?: boolean;
  canExpandAll?: boolean;
  canCollapseAll?: boolean;
  onExpandAll?(): void;
  onCollapseAll?(): void;
  spellCheckEnabled?: boolean;
  onToggleSpellCheck?(): void;
}

export async function installApplicationMenu(deps: MenuDeps): Promise<void> {
  const { Menu } = await import('electron');
  const template = buildMenuTemplate(deps);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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
    ...(isMac
      ? [
          {
            label: deps.appName,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              ...(deps.onCheckForUpdates
                ? ([
                    {
                      label: 'Check for updates…',
                      click: deps.onCheckForUpdates,
                    },
                    { type: 'separator' as const },
                  ] satisfies MenuItemConstructorOptions[])
                : []),
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
        {
          label: 'Recent project',
          submenu: recentSubmenu,
        },
        {
          label: `${MENU_LABELS.newProject}\u2026`,
          enabled: deps.onNewProject !== undefined,
          click: () => deps.onNewProject?.(),
        },
        {
          label: SWITCH_PROJECT_LABEL_WITH_ELLIPSIS,
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => deps.openNavigator(),
        },
        {
          label: `${MENU_LABELS.openFolder}\u2026`,
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const picked = await promptForExistingFolder(deps.dialog);
            if (picked) {
              await deps.openProject(picked, 'pick-existing');
            }
          },
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
        ...(deps.reconfigureMcpWiring
          ? ([
              {
                label: 'Configure AI tool integrations…',
                click: () => {
                  void deps.reconfigureMcpWiring?.();
                },
              },
              { type: 'separator' as const },
            ] satisfies MenuItemConstructorOptions[])
          : []),
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
          label: deps.terminalVisible ? 'Hide Terminal' : 'Show Terminal',
          accelerator: 'CmdOrCtrl+J',
          enabled: deps.onToggleTerminal !== undefined,
          click: () => deps.onToggleTerminal?.(),
        },
        { type: 'separator' },
        {
          label: MENU_LABELS.showHiddenFiles,
          accelerator: 'CmdOrCtrl+Shift+.',
          type: 'checkbox',
          checked: deps.showHiddenFilesChecked ?? false,
          enabled: deps.onToggleShowHiddenFiles !== undefined,
          click: () => deps.onToggleShowHiddenFiles?.(),
        },
        { type: 'separator' },
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
      label: 'Terminal',
      submenu: [
        {
          label: 'New Terminal',
          enabled: deps.onNewTerminal !== undefined,
          click: () => deps.onNewTerminal?.(),
        },
        {
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
