import {
  COMMAND_IDENTITIES,
  type CommandContext,
  type CommandIdentity,
  type CommandMenuPlacement,
  type ContextualTargetKind,
  evaluateCommandAvailability,
  MENU_LABELS,
  type MenuSection,
  menuLabelForPlatform,
  NATIVE_MENU_LABELS,
  OPEN_KNOWLEDGE_GITHUB_URL,
  SHOW_INSTALL_SKILL,
  type TerminalPlacement,
} from '@inkeep/open-knowledge-core';
import type { Dialog, MenuItemConstructorOptions } from 'electron';
import type { EntryPoint } from '../shared/entry-point.ts';
import type { EditorActiveTargetSnapshot } from '../shared/ipc-channels.ts';
import { promptForExistingFolder, promptForExistingMarkdownFile } from './dialog-helpers.ts';
import { type MenuTranslator, translateEnglish } from './menu-translator.ts';

export interface MenuDeps {
  onNavigateBack?(): void;
  onNavigateForward?(): void;
  appName: string;
  showDevToolsMenu: boolean;
  terminalCapable: boolean;
  dialog: Dialog;
  openNavigator(): void;
  openProject(projectPath: string, entryPoint: EntryPoint): Promise<void>;
  openEphemeralFile?(filePath: string): Promise<void>;
  getRecentProjects(): ReadonlyArray<{ path: string; name: string }>;
  clearRecentProjects(): void;
  getRecentFiles?(): ReadonlyArray<{ path: string; name: string }>;
  clearRecentFiles?(): void;
  openExternalUrl(url: string): void;
  reconfigureMcpWiring?(): Promise<void> | void;
  openInstallSkillDialog?(): void;
  openSettings?(): void;
  onReportBug?(): void;
  onSendFeedback?(): void;
  onCheckForUpdates?(): void;
  onUninstall?(): void;
  activeTarget?: EditorActiveTargetSnapshot;
  onOpenInNewWindow?(): void;
  onNewFile?(): void;
  onNewFolder?(): void;
  onNewFromTemplate?(): void;
  onNewProject?(): void;
  onNewWorktree?(): void;
  onSwitchWorktree?(): void;
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
  showOkFoldersChecked?: boolean;
  onToggleShowOkFolders?(): void;
  showOnlyMarkdownFilesChecked?: boolean;
  onToggleShowOnlyMarkdownFiles?(): void;
  showSkillsSectionChecked?: boolean;
  onToggleShowSkillsSection?(): void;
  sidebarVisible?: boolean;
  onToggleSidebar?(): void;
  noteWindow?: boolean;
  docPanelVisible?: boolean;
  onToggleDocPanel?(): void;
  terminalVisible?: boolean;
  onToggleTerminal?(): void;
  terminalPlacement?: TerminalPlacement;
  onMoveTerminal?(): void;
  agentPanelVisible?: boolean;
  hasEditorSelection?: boolean;
  onToggleAgentPanel?(): void;
  onNewTerminal?(): void;
  onKillTerminal?(): void;
  onNewTerminalWindow?(): void;
  terminalLive?: boolean;
  canExpandAll?: boolean;
  canCollapseAll?: boolean;
  onExpandAll?(): void;
  onCollapseAll?(): void;
  spellCheckEnabled?: boolean;
  onToggleSpellCheck?(): void;
  translate?: MenuTranslator;
}

function roleLabelSource(role: string, isMac: boolean): string | undefined {
  switch (role) {
    case 'about':
      return process.platform === 'linux'
        ? NATIVE_MENU_LABELS.roleAboutGeneric
        : NATIVE_MENU_LABELS.roleAbout;
    case 'quit':
      if (isMac) return NATIVE_MENU_LABELS.roleQuit;
      return process.platform === 'win32'
        ? NATIVE_MENU_LABELS.roleExit
        : NATIVE_MENU_LABELS.roleQuitGeneric;
    case 'close':
      return isMac ? NATIVE_MENU_LABELS.roleCloseWindow : NATIVE_MENU_LABELS.roleClose;
    case 'services':
      return NATIVE_MENU_LABELS.roleServices;
    case 'hide':
      return NATIVE_MENU_LABELS.roleHide;
    case 'hideOthers':
      return NATIVE_MENU_LABELS.roleHideOthers;
    case 'unhide':
      return NATIVE_MENU_LABELS.roleUnhide;
    case 'undo':
      return NATIVE_MENU_LABELS.roleUndo;
    case 'redo':
      return NATIVE_MENU_LABELS.roleRedo;
    case 'cut':
      return NATIVE_MENU_LABELS.roleCut;
    case 'copy':
      return NATIVE_MENU_LABELS.roleCopy;
    case 'paste':
      return NATIVE_MENU_LABELS.rolePaste;
    case 'selectAll':
      return NATIVE_MENU_LABELS.roleSelectAll;
    case 'reload':
      return NATIVE_MENU_LABELS.roleReload;
    case 'forceReload':
      return NATIVE_MENU_LABELS.roleForceReload;
    case 'toggleDevTools':
      return NATIVE_MENU_LABELS.roleToggleDevTools;
    case 'resetZoom':
      return NATIVE_MENU_LABELS.roleResetZoom;
    case 'zoomIn':
      return NATIVE_MENU_LABELS.roleZoomIn;
    case 'zoomOut':
      return NATIVE_MENU_LABELS.roleZoomOut;
    case 'togglefullscreen':
      return NATIVE_MENU_LABELS.roleToggleFullScreen;
    case 'minimize':
      return NATIVE_MENU_LABELS.roleMinimize;
    case 'zoom':
      return NATIVE_MENU_LABELS.roleZoom;
    case 'front':
      return NATIVE_MENU_LABELS.roleFront;
    default:
      return undefined;
  }
}

export async function installApplicationMenu(deps: MenuDeps): Promise<void> {
  const { Menu } = await import('electron');
  const template = buildMenuTemplate(deps);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

interface MenuCommandBinding {
  click?(deps: MenuDeps): MenuItemConstructorOptions['click'];
  enabled?(deps: MenuDeps): boolean;
  present?(deps: MenuDeps): boolean;
  checked?(deps: MenuDeps): boolean;
}

const MENU_BINDINGS: Record<string, MenuCommandBinding> = {
  'navigate-back': {
    click: (d) => () => d.onNavigateBack?.(),
    enabled: (d) => d.onNavigateBack !== undefined,
  },
  'navigate-forward': {
    click: (d) => () => d.onNavigateForward?.(),
    enabled: (d) => d.onNavigateForward !== undefined,
  },
  'open-in-new-window': {
    click: (d) => () => d.onOpenInNewWindow?.(),
    enabled: (d) => d.onOpenInNewWindow !== undefined,
  },
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
  'switch-project': { click: (d) => () => d.openNavigator() },
  'open-folder': {
    click: (d) => async () => {
      const picked = await promptForExistingFolder(d.dialog);
      if (picked) {
        await d.openProject(picked, 'pick-existing');
      }
    },
  },
  'open-file': {
    click: (d) => async () => {
      const picked = await promptForExistingMarkdownFile(d.dialog);
      if (picked) {
        await d.openEphemeralFile?.(picked);
      }
    },
    enabled: (d) => d.openEphemeralFile !== undefined,
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
  'check-for-updates': {
    click: (d) => d.onCheckForUpdates,
    present: (d) => d.onCheckForUpdates !== undefined,
  },
  uninstall: { click: (d) => () => d.onUninstall?.(), present: (d) => d.onUninstall !== undefined },
  'new-terminal': {
    click: (d) => () => d.onNewTerminal?.(),
    present: (d) => d.noteWindow !== true,
    enabled: (d) => d.onNewTerminal !== undefined,
  },
  'new-terminal-window': {
    click: (d) => () => d.onNewTerminalWindow?.(),
    enabled: (d) => d.onNewTerminalWindow !== undefined,
  },
  'kill-terminal': {
    click: (d) => () => d.onKillTerminal?.(),
    present: (d) => d.noteWindow !== true,
    enabled: (d) => d.onKillTerminal !== undefined,
  },
  'toggle-spell-check': {
    click: (d) => () => d.onToggleSpellCheck?.(),
    enabled: (d) => d.onToggleSpellCheck !== undefined,
    checked: (d) => d.spellCheckEnabled ?? true,
  },
  'toggle-sidebar': {
    click: (d) => () => d.onToggleSidebar?.(),
    present: (d) => d.noteWindow !== true,
    enabled: (d) => d.onToggleSidebar !== undefined,
  },
  'toggle-doc-panel': {
    click: (d) => () => d.onToggleDocPanel?.(),
    present: (d) => d.noteWindow !== true,
    enabled: (d) => d.onToggleDocPanel !== undefined,
  },
  'toggle-terminal': {
    click: (d) => () => d.onToggleTerminal?.(),
    present: (d) => d.noteWindow !== true,
    enabled: (d) => d.onToggleTerminal !== undefined,
  },
  'move-terminal': {
    click: (d) => () => d.onMoveTerminal?.(),
    present: (d) => d.noteWindow !== true,
    enabled: (d) => d.onMoveTerminal !== undefined,
  },
  'toggle-agent-panel': {
    click: (d) => () => d.onToggleAgentPanel?.(),
    present: (d) => d.noteWindow !== true,
    enabled: (d) => d.onToggleAgentPanel !== undefined,
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
  'report-bug': { click: (d) => () => d.onReportBug?.() },
  'send-feedback': { click: (d) => () => d.onSendFeedback?.() },
  'install-claude-desktop': {
    click: (d) => () => d.openInstallSkillDialog?.(),
    present: () => SHOW_INSTALL_SKILL,
  },
};

export const MENU_BINDING_IDS: ReadonlySet<string> = new Set(Object.keys(MENU_BINDINGS));

function menuTargetKind(target: EditorActiveTargetSnapshot | undefined): ContextualTargetKind {
  if (target === undefined || target.kind === null) return 'project';
  return target.kind;
}

function menuCommandContext(deps: MenuDeps): CommandContext {
  return {
    host: 'desktop',
    activeTargetKind: menuTargetKind(deps.activeTarget),
    singleFile: false,
    terminalCapable: deps.terminalCapable,
    terminalLive: deps.terminalLive === true,
    canExpandAll: deps.canExpandAll ?? true,
    canCollapseAll: deps.canCollapseAll ?? true,
    hasActiveDoc: deps.activeTarget?.kind === 'doc',
    showInstallSkill: SHOW_INSTALL_SKILL,
  };
}

function menuLeafLabel(
  cmd: CommandIdentity,
  placement: CommandMenuPlacement,
  deps: MenuDeps,
  translate: MenuTranslator,
): string {
  if (placement.menuLabelText !== undefined) return translate(placement.menuLabelText);
  if (cmd.stateToggle) {
    const { stateField, defaultVisible, showKey, hideKey, overrideKey, overrideField } =
      cmd.stateToggle;
    if (overrideKey !== undefined && overrideField !== undefined && deps[overrideField] === true) {
      return MENU_LABELS[overrideKey];
    }
    const visible = deps[stateField] ?? defaultVisible;
    return translate(MENU_LABELS[visible ? hideKey : showKey]);
  }
  if (cmd.placementToggle) {
    const key =
      deps.terminalPlacement === 'right'
        ? cmd.placementToggle.rightKey
        : cmd.placementToggle.bottomKey;
    return translate(MENU_LABELS[key]);
  }
  const key = placement.menuLabelKey ?? cmd.labelKey;
  if (key === undefined) {
    throw new Error(`command ${cmd.id} menu leaf has no resolvable label`);
  }
  return translate(menuLabelForPlatform(key, process.platform));
}

function buildCommandLeaves(
  deps: MenuDeps,
  isMac: boolean,
  translate: MenuTranslator,
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
      const label = menuLeafLabel(cmd, placement, deps, translate);
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

function withTrailingSep(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.length > 0 ? [...items, { type: 'separator' as const }] : [];
}

function withLeadingSep(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.length > 0 ? [{ type: 'separator' as const }, ...items] : [];
}

export function buildMenuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';
  const translate = deps.translate ?? translateEnglish;
  const recents = deps.getRecentProjects();
  const leaves = buildCommandLeaves(deps, isMac, translate);
  const leafOf = (section: MenuSection): MenuItemConstructorOptions[] => leaves.get(section) ?? [];

  const roleItem = <T extends MenuItemConstructorOptions['role'] & string>(
    role: T,
  ): MenuItemConstructorOptions => {
    const source = roleLabelSource(role, isMac);
    if (source === undefined) return { role };
    return { role, label: translate(source, { appName: deps.appName }) };
  };

  const recentSubmenu: MenuItemConstructorOptions[] =
    recents.length === 0
      ? [{ label: translate(NATIVE_MENU_LABELS.noRecentProjects), enabled: false }]
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
            label: translate(NATIVE_MENU_LABELS.clearMenu),
            click: () => deps.clearRecentProjects(),
          },
        ];

  const recentFiles = deps.getRecentFiles?.() ?? [];
  const recentFilesSubmenu: MenuItemConstructorOptions[] =
    recentFiles.length === 0
      ? [{ label: translate(NATIVE_MENU_LABELS.noRecentFiles), enabled: false }]
      : [
          ...recentFiles.slice(0, 10).map((row) => ({
            label: row.name,
            sublabel: row.path,
            click: () => {
              void deps.openEphemeralFile?.(row.path);
            },
          })),
          { type: 'separator' as const },
          {
            label: translate(NATIVE_MENU_LABELS.clearMenu),
            click: () => deps.clearRecentFiles?.(),
          },
        ];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: deps.appName,
            submenu: [
              roleItem('about'),
              { type: 'separator' as const },
              ...withTrailingSep(leafOf('app-updates')),
              ...leafOf('app-settings'),
              { type: 'separator' as const },
              roleItem('services'),
              { type: 'separator' as const },
              roleItem('hide'),
              roleItem('hideOthers'),
              roleItem('unhide'),
              { type: 'separator' as const },
              ...withTrailingSep(leafOf('app-uninstall')),
              roleItem('quit'),
            ],
          },
        ]
      : []),

    {
      label: translate(NATIVE_MENU_LABELS.menuFile),
      submenu: [
        ...leafOf('file-create'),
        { type: 'separator' },
        {
          label: translate(NATIVE_MENU_LABELS.recentProject),
          submenu: recentSubmenu,
        },
        ...(deps.getRecentFiles !== undefined
          ? [
              {
                label: translate(NATIVE_MENU_LABELS.recentFiles),
                submenu: recentFilesSubmenu,
              },
            ]
          : []),
        ...leafOf('file-project'),
        { type: 'separator' },
        ...leafOf('file-worktree'),
        { type: 'separator' },
        ...leafOf('file-item'),
        { type: 'separator' },
        ...leafOf('file-reveal'),
        {
          label: translate(MENU_LABELS.copyPath),
          enabled: deps.onCopyFullPath !== undefined || deps.onCopyRelativePath !== undefined,
          submenu: leafOf('file-copy-path'),
        },
        { type: 'separator' },
        ...withTrailingSep(leafOf('file-integrations')),
        ...withTrailingSep(leafOf('file-settings')),
        ...(isMac ? leafOf('file-close') : [roleItem('quit')]),
      ],
    },

    {
      label: translate(NATIVE_MENU_LABELS.menuEdit),
      submenu: [
        roleItem('undo'),
        roleItem('redo'),
        { type: 'separator' },
        roleItem('cut'),
        roleItem('copy'),
        roleItem('paste'),
        roleItem('selectAll'),
        { type: 'separator' },
        ...leafOf('edit-spell'),
      ],
    },

    {
      label: translate(NATIVE_MENU_LABELS.menuView),
      submenu: [
        ...leafOf('view-history'),
        { type: 'separator' as const },
        roleItem('reload'),
        roleItem('forceReload'),
        ...(deps.showDevToolsMenu
          ? ([roleItem('toggleDevTools')] satisfies MenuItemConstructorOptions[])
          : []),
        { type: 'separator' as const },
        ...leafOf('view-panels'),
        { type: 'separator' },
        ...leafOf('view-visibility'),
        { type: 'separator' },
        ...leafOf('view-tree'),
        { type: 'separator' },
        roleItem('resetZoom'),
        roleItem('zoomIn'),
        roleItem('zoomOut'),
        { type: 'separator' },
        roleItem('togglefullscreen'),
      ],
    },

    {
      label: translate(NATIVE_MENU_LABELS.menuTerminal),
      submenu: leafOf('terminal'),
    },

    {
      label: translate(NATIVE_MENU_LABELS.menuWindow),
      submenu: [
        ...withTrailingSep(leafOf('window')),
        roleItem('minimize'),
        ...(isMac
          ? ([
              roleItem('zoom'),
              { type: 'separator' as const },
              roleItem('front'),
            ] satisfies MenuItemConstructorOptions[])
          : ([roleItem('close')] satisfies MenuItemConstructorOptions[])),
      ],
    },

    {
      label: translate(NATIVE_MENU_LABELS.menuHelp),
      submenu: [
        ...withTrailingSep(leafOf('help-install')),
        ...leafOf('help-links'),
        ...withLeadingSep(leafOf('help-updates')),
      ],
    },
  ];

  return template;
}
