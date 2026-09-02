import type { MenuLabelKey } from '../constants/menu-labels.ts';

export type CommandGroup = 'commands' | 'project' | 'file' | 'view' | 'terminal' | 'app';

export type ContextualTargetKind = 'doc' | 'folder' | 'asset' | 'project' | 'none';

export type CommandHostScope = 'all' | 'desktop';

export interface CommandAvailabilitySpec {
  readonly host?: CommandHostScope;
  readonly requiresTargetKinds?: readonly ContextualTargetKind[];
  readonly singleFileHidden?: boolean;
  readonly requiresTerminalCapability?: boolean;
  readonly requiresTerminalLive?: boolean;
  readonly requiresCanExpandAll?: boolean;
  readonly requiresCanCollapseAll?: boolean;
  readonly requiresActiveDoc?: boolean;
  readonly requiresInstallSkill?: boolean;
}

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

export type MenuPlatform = 'all' | 'mac' | 'other';

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
  readonly order: number;
  readonly platform?: MenuPlatform;
  readonly accelerator?: string;
  readonly ellipsis?: boolean;
  readonly checkbox?: boolean;
  readonly smartHide?: boolean;
  readonly menuLabelKey?: MenuLabelKey;
  readonly menuLabelText?: string;
}

export interface CommandStateToggle {
  readonly showKey: MenuLabelKey;
  readonly hideKey: MenuLabelKey;
  readonly stateField:
    | 'sidebarVisible'
    | 'docPanelVisible'
    | 'terminalVisible'
    | 'agentPanelVisible';
  readonly defaultVisible: boolean;
  readonly overrideKey?: MenuLabelKey;
  readonly overrideField?: 'hasEditorSelection';
}

interface CommandPlacementToggle {
  readonly bottomKey: MenuLabelKey;
  readonly rightKey: MenuLabelKey;
}

export type CommandCheckField =
  | 'showHiddenFiles'
  | 'showOkFolders'
  | 'showOnlyMarkdownFiles'
  | 'showSkillsSection';

export interface CommandPalettePresence {
  readonly group: CommandGroup;
  readonly visibility: 'always' | 'search-only';
}

export interface CommandIdentity {
  readonly id: string;
  readonly menuActionId?: string;
  readonly labelKey?: MenuLabelKey;
  readonly keywords: readonly string[];
  readonly shortcutId?: string;
  readonly shortcutDesktopOnly?: boolean;
  readonly stateToggle?: CommandStateToggle;
  readonly placementToggle?: CommandPlacementToggle;
  readonly checkField?: CommandCheckField;
  readonly availability: CommandAvailabilitySpec;
  readonly palette?: CommandPalettePresence;
  readonly menu?: readonly CommandMenuPlacement[];
}

export const COMMAND_IDENTITIES: readonly CommandIdentity[] = [
  {
    id: 'open-blob-run',
    labelKey: 'blobRun',
    keywords: ['game', 'blob', 'runner', 'play', 'easter egg', 'dino'],
    availability: {},
    palette: { group: 'app', visibility: 'search-only' },
  },
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
    id: 'open-in-new-window',
    labelKey: 'openInNewWindow',
    keywords: ['pop out', 'detach', 'separate window', 'second monitor'],
    availability: { host: 'desktop', requiresActiveDoc: true, singleFileHidden: true },
    palette: { group: 'commands', visibility: 'always' },
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
    id: 'new-skill',
    labelKey: 'newSkill',
    keywords: ['skill', 'create', 'author', 'new'],
    availability: { singleFileHidden: true },
    palette: { group: 'commands', visibility: 'always' },
  },
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
    shortcutDesktopOnly: true,
    availability: { host: 'desktop' },
    palette: { group: 'project', visibility: 'always' },
    menu: [{ section: 'help-links', order: 1, ellipsis: true, accelerator: 'CmdOrCtrl+Shift+D' }],
  },
  {
    id: 'bug-report-history',
    labelKey: 'bugReportHistory',
    keywords: ['bug report history previous reports past retry resend'],
    availability: { host: 'desktop' },
    palette: { group: 'project', visibility: 'always' },
  },
  {
    id: 'send-feedback',
    menuActionId: 'send-feedback',
    labelKey: 'sendFeedback',
    keywords: ['feedback', 'suggestion', 'idea', 'rate', 'survey', 'contact', 'give'],
    availability: {},
    palette: { group: 'project', visibility: 'always' },
    menu: [{ section: 'help-links', order: 2, ellipsis: true }],
  },
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
