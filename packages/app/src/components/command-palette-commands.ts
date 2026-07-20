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
  Copy,
  Download,
  Eye,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FoldVertical,
  GitBranch,
  LayoutGrid,
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
  SquareTerminal,
  Trash2,
  UnfoldVertical,
  X,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import { GithubIcon } from '@/components/icons/github';
import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import type { OkDesktopBridge, OkMenuAction } from '@/lib/desktop-bridge-types';
import { i18n } from '@/lib/i18n';
import type { KeyboardShortcutId } from '@/lib/keyboard-shortcuts';
import { SETTINGS_OPEN_HASH } from '@/lib/use-settings-route';
import type { ViewMenuState } from '@/lib/view-menu-state-store';

/**
 * The Cmd+K palette's FIXED command rows, joined here from the shared command
 * identity (`@inkeep/open-knowledge-core/commands`, `COMMAND_IDENTITIES`) with
 * the renderer presentation the identity cannot carry: `lucide` icons, Lingui
 * `msg` labels (resolved through the app's global i18n), and dispatch closures
 * over the palette context. The native menu joins the SAME identity with its
 * own plain-string labels + click deps (`packages/desktop/src/main/menu.ts`),
 * so command identity has one declaration point across both surfaces.
 *
 * The palette's query/state-driven populations stay bespoke in
 * `CommandPalette.tsx` and are NOT registry rows: search results, tag mode,
 * semantic ("by meaning"), recents, the recent-project and worktree-switch
 * lists, and the per-target Open-with-AI group (`send-to-ai` is one
 * install-gated row per agent target, which a single descriptor cannot carry —
 * it stays a menu-only identity in the core registry).
 */

/**
 * Projection of the palette's 7-kind {@link ResolvedNavigationTarget} onto the
 * gating kinds the shared availability spec reads. The palette never produces
 * `project` (the menu's project-scope signal); a missing/absent target is
 * `none`, which is how reveal / copy-path hide with no target here yet stay
 * actionable in the menu's project scope — one spec, two contexts.
 */
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
      return 'none';
  }
}

/**
 * Everything a command needs to decide availability and to dispatch. The
 * palette component assembles this per render: state snapshots for
 * `available` / `label` / `checked`, and dispatch seams that reuse the existing
 * handlers (the local menu-action bus, toast-wrapped bridge calls, and the
 * palette's own dialog launchers).
 */
export interface PaletteCommandContext {
  bridge: OkDesktopBridge | null;
  /** No-project single-file session: project-scoped commands are hidden. */
  singleFile: boolean;
  activeDocName: string | null;
  contextualTargetKind: ContextualTargetKind;
  viewMenuState: ViewMenuState;
  /** Close the palette and emit the id on the local menu-action bus. */
  emitMenuAction(action: OkMenuAction): void;
  /** Close the palette and run `fn` with rejection surfaced as a toast. */
  runAction(fn: () => Promise<void> | void, fallback?: string): void;
  /** Close the palette and open `url` via the bridge shell (or window.open on web). */
  openExternalUrl(url: string): void;
  closePalette(): void;
  openNewItemDialog(kind: 'file' | 'folder'): void;
  openSeedDialog(): void;
  openCreateProjectDialog(): void;
  openReportBugDialog(): void;
}

/** Render-order buckets; the palette renders each group under its own heading. */
export type PaletteCommandGroup = 'commands' | 'project' | 'file' | 'view' | 'terminal' | 'app';

export interface PaletteCommand {
  /** Stable row id; the DOM testid is `command-palette-${id}`. */
  id: string;
  /**
   * The `OkMenuAction` this row makes palette-reachable, feeding the derived
   * `PALETTE_COMMAND_IDS` classification. For bus-dispatched rows this IS the id
   * `dispatch` emits, and the DOM suite's `ID_BACKED` loop pins that emission.
   * Absent for commands with no menu-action id (Settings, Open graph, …).
   */
  menuActionId?: OkMenuAction;
  /** Localized label, resolved at render so it tracks locale and reflects state. */
  label(ctx: PaletteCommandContext): string;
  /** Extra `matchesCommandQuery` tokens beyond the label. Not localized. */
  keywords: readonly string[];
  icon: ComponentType<{ className?: string }>;
  group: PaletteCommandGroup;
  /**
   * `always` rows render on empty open (query-filtered once the user types);
   * `search-only` rows render only under a matching non-empty query.
   */
  visibility: 'always' | 'search-only';
  /** Accelerator glyphs rendered via `formatShortcut(shortcutId)`. */
  shortcutId?: KeyboardShortcutId;
  /** The binding fires only through a native-menu accelerator (desktop host only). */
  shortcutDesktopOnly?: boolean;
  /** Trailing check indicator for checkbox-style View toggles. */
  checked?(ctx: PaletteCommandContext): boolean;
  available(ctx: PaletteCommandContext): boolean;
  dispatch(ctx: PaletteCommandContext): void;
}

/**
 * Palette label descriptors keyed by the registry `labelKey` (and Show/Hide
 * toggle keys). The label-parity test asserts this map covers every registry
 * labelKey and that each string is present in the compiled catalog, keeping the
 * palette in lockstep with the native menu's `MENU_LABELS` source.
 */
const PALETTE_COMMAND_LABELS = {
  newFile: msg`New file`,
  newFolder: msg`New folder`,
  openGraph: msg`Open graph`,
  initializeStarterPack: msg`Initialize starter pack`,
  newProject: msg`New project`,
  openFolderOnDisk: msg`Open folder on disk`,
  openFileOnDisk: msg`Open file on disk`,
  switchProject: msg`Switch project`,
  settings: msg`Settings`,
  installClaudeDesktop: msg`Install for Claude Chat & Cowork (Desktop App)`,
  reportBug: msg`Report a bug`,
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
  showHiddenFiles: msg`Show hidden files`,
  showOkFolders: msg`Show .ok folders`,
  showOnlyMarkdownFiles: msg`Show only markdown files`,
  showSkillsSection: msg`Show skills section`,
  expandAll: msg`Expand all`,
  collapseAll: msg`Collapse all`,
  newTerminal: msg`New Terminal`,
  killTerminal: msg`Kill Terminal`,
  checkForUpdates: msg`Check for updates`,
  setUpIntegrations: msg`Set up OpenKnowledge integrations`,
  checkSpelling: msg`Check spelling while typing`,
  openOnGithub: msg`OpenKnowledge on GitHub`,
} as const satisfies Record<string, MessageDescriptor>;

/** Exported for the label-parity test (completeness + catalog presence). */
export type PaletteLabelKey = keyof typeof PALETTE_COMMAND_LABELS;
export { PALETTE_COMMAND_LABELS };

/** Renderer icon per command id. Every palette command must have one:
 *  `toPaletteCommand` throws at module load if an id is missing, rather than
 *  silently substituting a wrong default. */
const COMMAND_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  'new-file': FilePlus2,
  'new-folder': FolderPlus,
  'open-graph': Network,
  'initialize-starter-pack': Package,
  'new-project': Plus,
  'open-folder': FolderOpen,
  'open-file': FileText,
  'switch-project': LayoutGrid,
  settings: Settings,
  'install-claude-desktop': Download,
  'report-bug': Bug,
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

/**
 * Dispatch closures for commands that do NOT route through the menu-action bus
 * (dialog launchers, bridge invokes, direct renderer calls). Bus commands fall
 * through to {@link busDispatch}, which emits their `menuActionId`.
 */
const COMMAND_DISPATCH: Record<string, (ctx: PaletteCommandContext) => void> = {
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
  'initialize-starter-pack': (ctx) => {
    ctx.closePalette();
    ctx.openSeedDialog();
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
    // The picker + ephemeral open both live main-side (`openEphemeralFile` owns
    // the temp server/dir lifecycle), so this is a single fire-and-forget hop —
    // no picked path crosses back to the renderer.
    ctx.runAction(() => bridge.project.openFile());
  },
  'switch-project': (ctx) => {
    const bridge = ctx.bridge;
    if (!bridge) return;
    ctx.runAction(() => bridge.navigator.open(), t`Failed to open Project Navigator.`);
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
    terminalLive: ctx.viewMenuState.terminalLive === true,
    canExpandAll: ctx.viewMenuState.canExpandAll !== false,
    canCollapseAll: ctx.viewMenuState.canCollapseAll !== false,
    hasActiveDoc: ctx.activeDocName !== null,
    showInstallSkill: SHOW_INSTALL_SKILL,
  };
}

function resolvePaletteLabel(cmd: CommandIdentity, ctx: PaletteCommandContext): string {
  if (cmd.stateToggle) {
    // Palette form: `state ? Hide : Show` (undefined → Show), independent of the
    // native menu's default-visible fallback.
    const visible = ctx.viewMenuState[cmd.stateToggle.stateField] === true;
    const key = visible ? cmd.stateToggle.hideKey : cmd.stateToggle.showKey;
    return i18n._(PALETTE_COMMAND_LABELS[key as PaletteLabelKey]);
  }
  return i18n._(PALETTE_COMMAND_LABELS[cmd.labelKey as PaletteLabelKey]);
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
