import {
  COMMAND_IDENTITIES,
  type CommandContext,
  type CommandIdentity,
  evaluateCommandAvailability,
  OPEN_KNOWLEDGE_GITHUB_URL,
  SHOW_INSTALL_SKILL,
} from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import {
  Blocks,
  Bug,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FoldVertical,
  Gamepad2,
  GitBranch,
  History,
  LayoutGrid,
  MessageSquare,
  Network,
  Package,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  SpellCheck,
  SquareArrowOutUpRight,
  SquareTerminal,
  Trash2,
  UnfoldVertical,
  X,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import { GithubIcon } from '@/components/icons/github';
import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import { requestSkillsDockExpanded } from '@/components/skills-dock-expanded-store';
import type { OkDesktopBridge, OkMenuAction } from '@/lib/desktop-bridge-types';
import { i18n } from '@/lib/i18n';
import type { KeyboardShortcutId } from '@/lib/keyboard-shortcuts';
import { openDocInNoteWindow } from '@/lib/open-note-window';
import { SETTINGS_OPEN_HASH } from '@/lib/use-settings-route';
import type { ViewMenuState } from '@/lib/view-menu-state-store';

export type ContextualTargetKind = 'doc' | 'folder' | 'asset' | 'none';

export function projectContextualTargetKind(
  target: ResolvedNavigationTarget | null,
): ContextualTargetKind {
  if (target === null) return 'none';
  switch (target.kind) {
    case 'doc':
    case 'folder-index':
      return 'doc';
    case 'folder':
      return 'folder';
    case 'asset':
    case 'skill-file':
    case 'large-file':
      return 'asset';
    case 'missing':
    case 'skills':
    case 'skill-preview':
      return 'none';
  }
}

export interface PaletteCommandContext {
  bridge: OkDesktopBridge | null;
  singleFile: boolean;
  activeDocName: string | null;
  contextualTargetKind: ContextualTargetKind;
  viewMenuState: ViewMenuState;
  emitMenuAction(action: OkMenuAction): void;
  runAction(fn: () => Promise<void> | void, fallback?: string): void;
  openExternalUrl(url: string): void;
  closePalette(): void;
  openNewItemDialog(kind: 'file' | 'folder'): void;
  openSeedDialog(): void;
  openCreateProjectDialog(): void;
  openReportBugDialog(): void;
  openBugReportHistory(): void;
  openFeedbackDialog(): void;
  createBlankSkill(): void;
  openBlobRun(): void;
}

export type PaletteCommandGroup = 'commands' | 'project' | 'file' | 'view' | 'terminal' | 'app';

export interface PaletteCommand {
  id: string;
  menuActionId?: OkMenuAction;
  label(ctx: PaletteCommandContext): string;
  keywords: readonly string[];
  icon: ComponentType<{ className?: string }>;
  group: PaletteCommandGroup;
  visibility: 'always' | 'search-only';
  shortcutId?: KeyboardShortcutId;
  shortcutDesktopOnly?: boolean;
  checked?(ctx: PaletteCommandContext): boolean;
  available(ctx: PaletteCommandContext): boolean;
  dispatch(ctx: PaletteCommandContext): void;
}

const PALETTE_COMMAND_LABELS = {
  blobRun: msg`Blob Run`,
  back: msg`Back`,
  forward: msg`Forward`,
  newFile: msg`New file`,
  newFolder: msg`New folder`,
  openGraph: msg`Open graph`,
  openInNewWindow: msg`Open in New Window`,
  initializeStarterPack: msg`Initialize starter pack`,
  newSkill: msg`New skill`,
  newProject: msg`New project`,
  openFolderOnDisk: msg`Open folder on disk`,
  openFileOnDisk: msg`Open file on disk`,
  switchProject: msg`Switch project`,
  openSkills: msg`Skills`,
  settings: msg`Settings`,
  installClaudeDesktop: msg`Install for Claude Chat & Cowork (Desktop App)`,
  reportBug: msg`Report a bug`,
  bugReportHistory: msg`Bug report history`,
  sendFeedback: msg`Send feedback`,
  newFromTemplate: msg`New from template`,
  rename: msg`Rename`,
  duplicate: msg`Duplicate`,
  moveToTrash: msg`Move to Trash`,
  revealInFinder: msg`Reveal in Finder`,
  copyFullPath: msg`Copy full path`,
  copyRelativePath: msg`Copy relative path`,
  closeTab: msg`Close tab`,
  newWorktree: msg`New worktree`,
  switchWorktree: msg`Switch worktree`,
  sidebarShow: msg`Show sidebar`,
  sidebarHide: msg`Hide sidebar`,
  docPanelShow: msg`Show document panel`,
  docPanelHide: msg`Hide document panel`,
  terminalShow: msg`Show Terminal`,
  terminalHide: msg`Hide Terminal`,
  terminalMoveRight: msg`Move Terminal to right`,
  terminalMoveBottom: msg`Move Terminal to bottom`,
  agentPanelShow: msg`Show Agents`,
  agentPanelHide: msg`Hide Agents`,
  agentPanelAskSelection: msg`Ask AI About Selection`,
  showHiddenFiles: msg`Show hidden files`,
  showOkFolders: msg`Show .ok folders`,
  showOnlyMarkdownFiles: msg`Show only markdown files`,
  showSkillsSection: msg`Skills section`,
  expandAll: msg`Expand all`,
  collapseAll: msg`Collapse all`,
  newTerminal: msg`New Terminal`,
  killTerminal: msg`Kill Terminal`,
  checkForUpdates: msg`Check for updates`,
  setUpIntegrations: msg`Set up OpenKnowledge integrations`,
  checkSpelling: msg`Check spelling while typing`,
  openOnGithub: msg`OpenKnowledge on GitHub`,
} as const satisfies Record<string, MessageDescriptor>;

export type PaletteLabelKey = keyof typeof PALETTE_COMMAND_LABELS;
export { PALETTE_COMMAND_LABELS };

const PLATFORM_PALETTE_COMMAND_LABELS = {
  win32: {
    revealInFinder: msg`Reveal in File Explorer`,
    moveToTrash: msg`Move to Recycle Bin`,
  },
  linux: {
    revealInFinder: msg`Open containing folder`,
  },
} as const satisfies Record<'win32' | 'linux', Partial<Record<PaletteLabelKey, MessageDescriptor>>>;

export { PLATFORM_PALETTE_COMMAND_LABELS };

function paletteLabelDescriptor(
  key: PaletteLabelKey,
  platform: string | null | undefined,
): MessageDescriptor {
  if (platform === 'win32' || platform === 'linux') {
    const override = (
      PLATFORM_PALETTE_COMMAND_LABELS[platform] as Partial<
        Record<PaletteLabelKey, MessageDescriptor>
      >
    )[key];
    if (override) return override;
  }
  return PALETTE_COMMAND_LABELS[key];
}

const COMMAND_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  'open-blob-run': Gamepad2,
  'navigate-back': ChevronLeft,
  'navigate-forward': ChevronRight,
  'new-file': FilePlus2,
  'new-folder': FolderPlus,
  'open-graph': Network,
  'open-in-new-window': SquareArrowOutUpRight,
  'initialize-starter-pack': Package,
  'new-skill': Sparkles,
  'new-project': Plus,
  'open-folder': FolderOpen,
  'open-file': FileText,
  'switch-project': LayoutGrid,
  'open-skills': Package,
  settings: Settings,
  'install-claude-desktop': Download,
  'report-bug': Bug,
  'bug-report-history': History,
  'send-feedback': MessageSquare,
  'new-from-template': FilePlus2,
  rename: Pencil,
  duplicate: Copy,
  'move-to-trash': Trash2,
  'reveal-in-finder': FolderOpen,
  'copy-full-path': Copy,
  'copy-relative-path': Copy,
  'close-tab': X,
  'new-worktree': GitBranch,
  'switch-worktree': GitBranch,
  'toggle-sidebar': PanelLeft,
  'toggle-doc-panel': PanelRight,
  'toggle-terminal': SquareTerminal,
  'move-terminal': SquareTerminal,
  'toggle-agent-panel': MessageSquare,
  'toggle-show-hidden-files': Eye,
  'toggle-show-ok-folders': Folder,
  'toggle-show-only-markdown-files': FileText,
  'toggle-show-skills-section': Sparkles,
  'expand-all-tree': UnfoldVertical,
  'collapse-all-tree': FoldVertical,
  'new-terminal': SquareTerminal,
  'kill-terminal': SquareTerminal,
  'check-for-updates': RefreshCw,
  'set-up-integrations': Blocks,
  'toggle-spell-check': SpellCheck,
  'open-github': GithubIcon,
};

const COMMAND_DISPATCH: Record<string, (ctx: PaletteCommandContext) => void> = {
  'open-blob-run': (ctx) => ctx.openBlobRun(),
  'new-file': (ctx) => {
    ctx.closePalette();
    ctx.openNewItemDialog('file');
  },
  'new-folder': (ctx) => {
    ctx.closePalette();
    ctx.openNewItemDialog('folder');
  },
  'open-graph': (ctx) => {
    ctx.closePalette();
    requestDocPanelTab('graph');
  },
  'open-in-new-window': (ctx) => {
    ctx.closePalette();
    if (ctx.activeDocName) void openDocInNoteWindow(ctx.activeDocName, 'palette');
  },
  'initialize-starter-pack': (ctx) => {
    ctx.closePalette();
    ctx.openSeedDialog();
  },
  'new-skill': (ctx) => {
    ctx.closePalette();
    ctx.createBlankSkill();
  },
  'new-project': (ctx) => {
    ctx.closePalette();
    ctx.openCreateProjectDialog();
  },
  'open-folder': (ctx) => {
    const bridge = ctx.bridge;
    if (!bridge) return;
    ctx.runAction(async () => {
      const path = await bridge.dialog.openFolder();
      if (!path) return;
      await bridge.project.open({ path, target: 'new-window', entryPoint: 'pick-existing' });
    });
  },
  'open-file': (ctx) => {
    const bridge = ctx.bridge;
    if (!bridge) return;
    ctx.runAction(() => bridge.project.openFile());
  },
  'switch-project': (ctx) => {
    const bridge = ctx.bridge;
    if (!bridge) return;
    ctx.runAction(() => bridge.navigator.open(), t`Failed to open Project Navigator.`);
  },
  'open-skills': (ctx) => {
    ctx.closePalette();
    requestSkillsDockExpanded();
  },
  settings: (ctx) => {
    ctx.closePalette();
    if (window.location.hash !== SETTINGS_OPEN_HASH) {
      window.location.hash = SETTINGS_OPEN_HASH;
    }
  },
  'install-claude-desktop': (ctx) => {
    ctx.closePalette();
    window.location.hash = '#install-claude-desktop';
  },
  'report-bug': (ctx) => {
    ctx.closePalette();
    ctx.openReportBugDialog();
  },
  'bug-report-history': (ctx) => {
    ctx.closePalette();
    ctx.openBugReportHistory();
  },
  'send-feedback': (ctx) => {
    ctx.closePalette();
    ctx.openFeedbackDialog();
  },
  'check-for-updates': (ctx) =>
    ctx.runAction(async () => {
      await ctx.bridge?.update.checkNow();
    }),
  'set-up-integrations': (ctx) =>
    ctx.runAction(async () => {
      await ctx.bridge?.mcpWiring.reconfigure();
    }),
  'toggle-spell-check': (ctx) =>
    ctx.runAction(async () => {
      await ctx.bridge?.spellcheck.toggle();
    }),
  'open-github': (ctx) => ctx.openExternalUrl(OPEN_KNOWLEDGE_GITHUB_URL),
};

function paletteCoreContext(ctx: PaletteCommandContext): CommandContext {
  return {
    host: ctx.bridge !== null ? 'desktop' : 'web',
    activeTargetKind: ctx.contextualTargetKind,
    singleFile: ctx.singleFile,
    terminalCapable:
      ctx.bridge !== null && ctx.bridge.terminal != null && ctx.bridge.config.ptyAvailable === true,
    terminalLive: ctx.viewMenuState.terminalLive === true,
    canExpandAll: ctx.viewMenuState.canExpandAll !== false,
    canCollapseAll: ctx.viewMenuState.canCollapseAll !== false,
    hasActiveDoc: ctx.activeDocName !== null,
    showInstallSkill: SHOW_INSTALL_SKILL,
  };
}

function resolvePaletteLabel(cmd: CommandIdentity, ctx: PaletteCommandContext): string {
  const platform = ctx.bridge?.platform;
  if (cmd.stateToggle) {
    const { overrideKey, overrideField } = cmd.stateToggle;
    if (
      overrideKey !== undefined &&
      overrideField !== undefined &&
      ctx.viewMenuState[overrideField] === true
    ) {
      return i18n._(PALETTE_COMMAND_LABELS[overrideKey as PaletteLabelKey]);
    }
    const visible = ctx.viewMenuState[cmd.stateToggle.stateField] === true;
    const key = visible ? cmd.stateToggle.hideKey : cmd.stateToggle.showKey;
    return i18n._(paletteLabelDescriptor(key as PaletteLabelKey, platform));
  }
  if (cmd.placementToggle) {
    const key =
      ctx.viewMenuState.terminalPlacement === 'right'
        ? cmd.placementToggle.rightKey
        : cmd.placementToggle.bottomKey;
    return i18n._(paletteLabelDescriptor(key as PaletteLabelKey, platform));
  }
  return i18n._(paletteLabelDescriptor(cmd.labelKey as PaletteLabelKey, platform));
}

function busDispatch(cmd: CommandIdentity): (ctx: PaletteCommandContext) => void {
  const action = cmd.menuActionId as OkMenuAction;
  return (ctx) => ctx.emitMenuAction(action);
}

function toPaletteCommand(cmd: CommandIdentity): PaletteCommand {
  const presence = cmd.palette;
  if (!presence) throw new Error(`command ${cmd.id} has no palette presence`);
  const icon = COMMAND_ICONS[cmd.id];
  if (!icon) throw new Error(`command ${cmd.id} has no palette icon`);
  const checkField = cmd.checkField;
  return {
    id: cmd.id,
    menuActionId: cmd.menuActionId as OkMenuAction | undefined,
    label: (ctx) => resolvePaletteLabel(cmd, ctx),
    keywords: cmd.keywords,
    icon,
    group: presence.group,
    visibility: presence.visibility,
    shortcutId: cmd.shortcutId as KeyboardShortcutId | undefined,
    shortcutDesktopOnly: cmd.shortcutDesktopOnly,
    checked: checkField ? (ctx) => ctx.viewMenuState[checkField] === true : undefined,
    available: (ctx) => evaluateCommandAvailability(cmd.availability, paletteCoreContext(ctx)),
    dispatch: COMMAND_DISPATCH[cmd.id] ?? busDispatch(cmd),
  };
}

export const PALETTE_COMMANDS: readonly PaletteCommand[] = COMMAND_IDENTITIES.flatMap((cmd) =>
  cmd.palette ? [toPaletteCommand(cmd)] : [],
);
