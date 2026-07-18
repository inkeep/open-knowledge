import { OPEN_KNOWLEDGE_GITHUB_URL, SHOW_INSTALL_SKILL } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
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
import type { KeyboardShortcutId } from '@/lib/keyboard-shortcuts';
import { SETTINGS_OPEN_HASH } from '@/lib/use-settings-route';
import type { ViewMenuState } from '@/lib/view-menu-state-store';

/**
 * The command registry for the Cmd+K palette's FIXED command rows — the single
 * source of truth the palette renders from, and the source the parity ratchets
 * derive their palette-reachable id classification from
 * (`command-menu-parity.test-helper.ts`).
 *
 * Fixed commands only. The palette's query/state-driven populations stay
 * bespoke in `CommandPalette.tsx` and are deliberately NOT registry entries:
 * search results, tag mode, semantic ("by meaning"), recents, the recent-project
 * and worktree-switch lists, and the per-target Open-with-AI group (`send-to-ai`
 * is one install-gated row per agent target, which a single descriptor cannot
 * represent).
 *
 * The native menu stays hand-authored (`packages/desktop/src/main/menu.ts`);
 * Ratchet B classifies its leaves against this registry's id space. Rendering
 * the menu from the registry is a separate step gated on where labels and
 * availability predicates can live (the menu runs in the Electron main process,
 * outside the Lingui macro pipeline).
 */

/**
 * Projection of the palette's 7-kind {@link ResolvedNavigationTarget} onto the
 * 4-kind gating the native File menu uses for contextual commands: doc-like and
 * folder allow every contextual command (folder still allows Duplicate);
 * asset-like (asset / skill-file / large-file) disables Duplicate; a missing /
 * absent target hides them all.
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
 * palette's own dialog launchers) so no handler logic is re-implemented here.
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
   * `PALETTE_COMMAND_IDS` classification (Ratchets A/C). Two roles:
   *   - `busDispatch` rows: this IS the id `dispatch` emits on the menu-action
   *     bus, and the DOM suite's `ID_BACKED` loop pins that emission, so the two
   *     cannot drift.
   *   - dialog rows (whose `dispatch` opens a dialog instead of calling
   *     `emitMenuAction`): a classification-only annotation. Dispatch emits
   *     nothing, so no dispatch test guards it; set it by hand to the matching
   *     native menu leaf's action.
   * Absent for commands with no menu-action id (Settings, Open graph, …).
   */
  menuActionId?: OkMenuAction;
  /**
   * Localized label, resolved at render time so it tracks the active locale
   * and can reflect state (Show/Hide toggles read `ctx.viewMenuState`).
   */
  label(ctx: PaletteCommandContext): string;
  /** Extra `matchesCommandQuery` tokens beyond the label. Not localized. */
  keywords: readonly string[];
  icon: ComponentType<{ className?: string }>;
  group: PaletteCommandGroup;
  /**
   * `always` rows render on empty open (query-filtered once the user types);
   * `search-only` rows render only under a matching non-empty query, keeping
   * the empty-open state lean.
   */
  visibility: 'always' | 'search-only';
  /** Accelerator glyphs rendered via `formatShortcut(shortcutId)`. */
  shortcutId?: KeyboardShortcutId;
  /**
   * The binding only fires through a native-menu accelerator, so the glyphs
   * render on the desktop host only.
   */
  shortcutDesktopOnly?: boolean;
  /** Trailing check indicator for checkbox-style View toggles. */
  checked?(ctx: PaletteCommandContext): boolean;
  available(ctx: PaletteCommandContext): boolean;
  dispatch(ctx: PaletteCommandContext): void;
}

const contextualAvailable = (ctx: PaletteCommandContext): boolean =>
  ctx.bridge !== null && ctx.contextualTargetKind !== 'none';

/**
 * Fields for a command whose dispatch is exactly "emit this id on the local
 * menu-action bus": one action literal produces BOTH the classification
 * (`menuActionId`) and the dispatch that emits it, so the two cannot drift.
 */
const busDispatch = (action: OkMenuAction): Pick<PaletteCommand, 'menuActionId' | 'dispatch'> => ({
  menuActionId: action,
  dispatch: (ctx) => ctx.emitMenuAction(action),
});

export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  // ── Commands ──────────────────────────────────────────────────────────────
  {
    id: 'new-file',
    menuActionId: 'new-doc',
    label: () => t`New file`,
    keywords: ['create file'],
    icon: FilePlus2,
    group: 'commands',
    visibility: 'always',
    shortcutId: 'new-item',
    available: () => true,
    dispatch: (ctx) => {
      ctx.closePalette();
      ctx.openNewItemDialog('file');
    },
  },
  {
    id: 'new-folder',
    menuActionId: 'new-folder',
    label: () => t`New folder`,
    keywords: ['create folder'],
    icon: FolderPlus,
    group: 'commands',
    visibility: 'always',
    shortcutId: 'new-folder',
    // The ⇧⌘N chord is a native-menu accelerator with no web keydown handler.
    shortcutDesktopOnly: true,
    available: () => true,
    dispatch: (ctx) => {
      ctx.closePalette();
      ctx.openNewItemDialog('folder');
    },
  },
  {
    id: 'open-graph',
    label: () => t`Open graph`,
    keywords: ['graph panel network'],
    icon: Network,
    group: 'commands',
    visibility: 'always',
    available: (ctx) => ctx.activeDocName !== null,
    dispatch: (ctx) => {
      ctx.closePalette();
      requestDocPanelTab('graph');
    },
  },
  {
    id: 'initialize-starter-pack',
    label: () => t`Initialize starter pack`,
    keywords: ['scaffold', 'seed', 'pack', 'starter'],
    icon: Package,
    group: 'commands',
    visibility: 'always',
    available: () => true,
    dispatch: (ctx) => {
      ctx.closePalette();
      ctx.openSeedDialog();
    },
  },
  // ── Project ───────────────────────────────────────────────────────────────
  {
    id: 'new-project',
    menuActionId: 'new-project',
    label: () => t`New project`,
    keywords: ['create new project scaffold'],
    icon: Plus,
    group: 'project',
    visibility: 'always',
    available: (ctx) => ctx.bridge !== null,
    dispatch: (ctx) => {
      ctx.closePalette();
      ctx.openCreateProjectDialog();
    },
  },
  {
    id: 'open-folder',
    label: () => t`Open folder on disk`,
    keywords: ['project'],
    icon: FolderOpen,
    group: 'project',
    visibility: 'always',
    shortcutId: 'open-folder',
    available: (ctx) => ctx.bridge !== null,
    dispatch: (ctx) => {
      const bridge = ctx.bridge;
      if (!bridge) return;
      ctx.runAction(async () => {
        const path = await bridge.dialog.openFolder();
        if (!path) return;
        await bridge.project.open({
          path,
          target: 'new-window',
          entryPoint: 'pick-existing',
        });
      });
    },
  },
  {
    id: 'switch-project',
    label: () => t`Switch project`,
    keywords: ['switch project navigator projects'],
    icon: LayoutGrid,
    group: 'project',
    visibility: 'always',
    shortcutId: 'switch-project',
    available: (ctx) => ctx.bridge !== null && !ctx.singleFile,
    dispatch: (ctx) => {
      const bridge = ctx.bridge;
      if (!bridge) return;
      ctx.runAction(() => bridge.navigator.open(), t`Failed to open Project Navigator.`);
    },
  },
  {
    id: 'settings',
    label: () => t`Settings`,
    keywords: ['preferences config'],
    icon: Settings,
    group: 'project',
    visibility: 'always',
    shortcutId: 'settings',
    available: (ctx) => !ctx.singleFile,
    dispatch: (ctx) => {
      ctx.closePalette();
      if (window.location.hash !== SETTINGS_OPEN_HASH) {
        window.location.hash = SETTINGS_OPEN_HASH;
      }
    },
  },
  {
    id: 'install-claude-desktop',
    label: () => t`Install for Claude Chat & Cowork (Desktop App)`,
    keywords: ['claude desktop install cowork'],
    icon: Download,
    group: 'project',
    visibility: 'always',
    available: () => SHOW_INSTALL_SKILL,
    dispatch: (ctx) => {
      ctx.closePalette();
      window.location.hash = '#install-claude-desktop';
    },
  },
  {
    id: 'report-bug',
    menuActionId: 'report-bug',
    label: () => t`Report a bug`,
    keywords: ['bug report issue feedback problem'],
    icon: Bug,
    group: 'project',
    visibility: 'always',
    // Bundle creation runs over the Electron bridge. Not gated on `singleFile`:
    // with no project open the report degrades to the system-wide bundle.
    available: (ctx) => ctx.bridge !== null,
    dispatch: (ctx) => {
      ctx.closePalette();
      ctx.openReportBugDialog();
    },
  },
  // ── File ──────────────────────────────────────────────────────────────────
  {
    id: 'new-from-template',
    ...busDispatch('new-from-template'),
    label: () => t`New from template`,
    keywords: ['template', 'create', 'new'],
    icon: FilePlus2,
    group: 'file',
    visibility: 'search-only',
    available: (ctx) => !ctx.singleFile,
  },
  {
    id: 'rename',
    ...busDispatch('rename'),
    label: () => t`Rename`,
    keywords: ['rename', 'file', 'folder'],
    icon: Pencil,
    group: 'file',
    visibility: 'search-only',
    available: contextualAvailable,
  },
  {
    id: 'duplicate',
    ...busDispatch('duplicate'),
    label: () => t`Duplicate`,
    keywords: ['duplicate', 'copy', 'file', 'folder'],
    icon: Copy,
    group: 'file',
    visibility: 'search-only',
    shortcutId: 'file-tree-duplicate',
    available: (ctx) =>
      ctx.bridge !== null &&
      (ctx.contextualTargetKind === 'doc' || ctx.contextualTargetKind === 'folder'),
  },
  {
    id: 'move-to-trash',
    ...busDispatch('move-to-trash'),
    label: () => t`Move to Trash`,
    keywords: ['delete', 'trash', 'remove'],
    icon: Trash2,
    group: 'file',
    visibility: 'search-only',
    shortcutId: 'file-tree-delete',
    available: contextualAvailable,
  },
  {
    id: 'reveal-in-finder',
    ...busDispatch('reveal-in-finder'),
    label: () => t`Reveal in Finder`,
    keywords: ['finder', 'reveal', 'show', 'file'],
    icon: FolderOpen,
    group: 'file',
    visibility: 'search-only',
    available: contextualAvailable,
  },
  {
    id: 'copy-full-path',
    ...busDispatch('copy-full-path'),
    label: () => t`Copy full path`,
    keywords: ['copy', 'path', 'absolute', 'full'],
    icon: Copy,
    group: 'file',
    visibility: 'search-only',
    available: contextualAvailable,
  },
  {
    id: 'copy-relative-path',
    ...busDispatch('copy-relative-path'),
    label: () => t`Copy relative path`,
    keywords: ['copy', 'path', 'relative'],
    icon: Copy,
    group: 'file',
    visibility: 'search-only',
    available: contextualAvailable,
  },
  {
    id: 'close-tab',
    ...busDispatch('close-active-tab-or-window'),
    label: () => t`Close tab`,
    keywords: ['close', 'tab', 'window'],
    icon: X,
    group: 'file',
    visibility: 'search-only',
    available: (ctx) => ctx.bridge !== null,
  },
  {
    id: 'new-worktree',
    ...busDispatch('new-worktree'),
    label: () => t`New worktree`,
    keywords: ['worktree', 'branch', 'new'],
    icon: GitBranch,
    group: 'file',
    visibility: 'search-only',
    available: (ctx) => ctx.bridge !== null,
  },
  {
    id: 'switch-worktree',
    ...busDispatch('switch-worktree'),
    label: () => t`Switch worktree`,
    keywords: ['worktree', 'switch', 'branch'],
    icon: GitBranch,
    group: 'file',
    visibility: 'search-only',
    available: (ctx) => ctx.bridge !== null,
  },
  // ── View ──────────────────────────────────────────────────────────────────
  {
    id: 'toggle-sidebar',
    ...busDispatch('toggle-sidebar'),
    label: (ctx) => (ctx.viewMenuState.sidebarVisible ? t`Hide sidebar` : t`Show sidebar`),
    keywords: ['sidebar', 'files', 'panel', 'toggle'],
    icon: PanelLeft,
    group: 'view',
    visibility: 'search-only',
    shortcutId: 'toggle-files-sidebar',
    available: () => true,
  },
  {
    id: 'toggle-doc-panel',
    ...busDispatch('toggle-doc-panel'),
    label: (ctx) =>
      ctx.viewMenuState.docPanelVisible ? t`Hide document panel` : t`Show document panel`,
    keywords: ['document', 'panel', 'info', 'toggle'],
    icon: PanelRight,
    group: 'view',
    visibility: 'search-only',
    shortcutId: 'toggle-document-panel',
    available: () => true,
  },
  {
    id: 'toggle-terminal',
    ...busDispatch('toggle-terminal'),
    label: (ctx) => (ctx.viewMenuState.terminalVisible ? t`Hide Terminal` : t`Show Terminal`),
    keywords: ['terminal', 'shell', 'console', 'toggle'],
    icon: SquareTerminal,
    group: 'view',
    visibility: 'search-only',
    shortcutId: 'toggle-terminal-panel',
    available: (ctx) => ctx.bridge !== null,
  },
  {
    id: 'toggle-show-hidden-files',
    ...busDispatch('toggle-show-hidden-files'),
    label: () => t`Show hidden files`,
    keywords: ['hidden', 'dotfiles', 'files', 'show'],
    icon: Eye,
    group: 'view',
    visibility: 'search-only',
    checked: (ctx) => ctx.viewMenuState.showHiddenFiles === true,
    available: () => true,
  },
  {
    id: 'toggle-show-ok-folders',
    ...busDispatch('toggle-show-ok-folders'),
    label: () => t`Show .ok folders`,
    keywords: ['ok', 'folders', 'hidden', 'show'],
    icon: Folder,
    group: 'view',
    visibility: 'search-only',
    checked: (ctx) => ctx.viewMenuState.showOkFolders === true,
    available: () => true,
  },
  {
    id: 'toggle-show-only-markdown-files',
    ...busDispatch('toggle-show-only-markdown-files'),
    label: () => t`Show only markdown files`,
    keywords: ['markdown', 'filter', 'files', 'only'],
    icon: FileText,
    group: 'view',
    visibility: 'search-only',
    checked: (ctx) => ctx.viewMenuState.showOnlyMarkdownFiles === true,
    available: () => true,
  },
  {
    id: 'toggle-show-skills-section',
    ...busDispatch('toggle-show-skills-section'),
    label: () => t`Show skills section`,
    keywords: ['skills', 'section', 'sidebar', 'show'],
    icon: Sparkles,
    group: 'view',
    visibility: 'search-only',
    checked: (ctx) => ctx.viewMenuState.showSkillsSection === true,
    available: () => true,
  },
  {
    id: 'expand-all-tree',
    ...busDispatch('expand-all-tree'),
    label: () => t`Expand all`,
    keywords: ['expand', 'tree', 'folders', 'all'],
    icon: UnfoldVertical,
    group: 'view',
    visibility: 'search-only',
    // Mirror the native menu's smart-hide (visible: canExpandAll ?? true):
    // suppress the row when the tree is already fully expanded, so searching
    // "expand" doesn't surface a pure no-op. Unknown (web/pre-push) stays available.
    available: (ctx) => ctx.viewMenuState.canExpandAll !== false,
  },
  {
    id: 'collapse-all-tree',
    ...busDispatch('collapse-all-tree'),
    label: () => t`Collapse all`,
    keywords: ['collapse', 'tree', 'folders', 'all'],
    icon: FoldVertical,
    group: 'view',
    visibility: 'search-only',
    // Mirror the native menu's smart-hide (visible: canCollapseAll ?? true).
    available: (ctx) => ctx.viewMenuState.canCollapseAll !== false,
  },
  // ── Terminal ──────────────────────────────────────────────────────────────
  {
    id: 'new-terminal',
    ...busDispatch('new-terminal'),
    label: () => t`New Terminal`,
    keywords: ['terminal', 'shell', 'new', 'tab'],
    icon: SquareTerminal,
    group: 'terminal',
    visibility: 'search-only',
    available: (ctx) => ctx.bridge !== null,
  },
  {
    id: 'kill-terminal',
    ...busDispatch('kill-terminal'),
    label: () => t`Kill Terminal`,
    keywords: ['terminal', 'kill', 'close', 'session'],
    icon: SquareTerminal,
    group: 'terminal',
    visibility: 'search-only',
    available: (ctx) => ctx.bridge !== null && ctx.viewMenuState.terminalLive === true,
  },
  // ── Application ───────────────────────────────────────────────────────────
  {
    id: 'check-for-updates',
    label: () => t`Check for updates`,
    keywords: ['update', 'upgrade', 'version', 'check'],
    icon: RefreshCw,
    group: 'app',
    visibility: 'search-only',
    available: (ctx) => ctx.bridge !== null,
    dispatch: (ctx) =>
      ctx.runAction(async () => {
        await ctx.bridge?.update.checkNow();
      }),
  },
  {
    id: 'set-up-integrations',
    label: () => t`Set up OpenKnowledge integrations`,
    keywords: ['integrations', 'mcp', 'setup', 'claude', 'configure'],
    icon: Blocks,
    group: 'app',
    visibility: 'search-only',
    available: (ctx) => ctx.bridge !== null,
    dispatch: (ctx) =>
      ctx.runAction(async () => {
        await ctx.bridge?.mcpWiring.reconfigure();
      }),
  },
  {
    id: 'toggle-spell-check',
    label: () => t`Check spelling while typing`,
    keywords: ['spell', 'spelling', 'check', 'typing'],
    icon: SpellCheck,
    group: 'app',
    visibility: 'search-only',
    // App-wide flag owned by the Electron main process (not view-menu-state):
    // the invoke reads + toggles it there, so the row carries no checkmark.
    available: (ctx) => ctx.bridge !== null,
    dispatch: (ctx) =>
      ctx.runAction(async () => {
        await ctx.bridge?.spellcheck.toggle();
      }),
  },
  {
    id: 'open-github',
    label: () => t`OpenKnowledge on GitHub`,
    keywords: ['github', 'source', 'repository', 'code'],
    icon: GithubIcon,
    group: 'app',
    visibility: 'search-only',
    available: () => true,
    dispatch: (ctx) => ctx.openExternalUrl(OPEN_KNOWLEDGE_GITHUB_URL),
  },
];
