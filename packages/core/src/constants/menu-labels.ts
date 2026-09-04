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
  showSkillsSection: 'Skills section',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  moveToTrash: 'Move to Trash',
  copyFullPath: 'Copy full path',
  copyRelativePath: 'Copy relative path',
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
  switchProject: 'Switch project',
  openSkills: 'Skills',
  settings: 'Settings',
  openFolderOnDisk: 'Open folder on disk',
  openFileOnDisk: 'Open file on disk',
  openGraph: 'Open graph',
  openInNewWindow: 'Open in New Window',
  blobRun: 'Blob Run',
  initializeStarterPack: 'Initialize starter pack',
  newSkill: 'New skill',
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
  agentPanelAskSelection: 'Ask AI About Selection',
  installClaudeDesktop: 'Install for Claude Chat & Cowork (Desktop App)',
} as const satisfies Record<string, string>;

export type MenuLabelKey = keyof typeof MENU_LABELS;

export const PLATFORM_MENU_LABELS: Partial<
  Record<MenuLabelKey, Partial<Record<'win32' | 'linux', string>>>
> = {
  revealInFinder: { win32: 'Reveal in File Explorer', linux: 'Open containing folder' },
  moveToTrash: { win32: 'Move to Recycle Bin' },
};

export function menuLabelForPlatform(key: MenuLabelKey, platform: string): string {
  const overrides = PLATFORM_MENU_LABELS[key];
  if (overrides && (platform === 'win32' || platform === 'linux')) {
    const override = overrides[platform];
    if (override !== undefined) return override;
  }
  return MENU_LABELS[key];
}

export const OPEN_KNOWLEDGE_GITHUB_URL = 'https://github.com/inkeep/open-knowledge';
