import type { OkMenuAction } from '../shared/bridge-contract';
import type { EditorViewMenuStateSnapshot } from '../shared/ipc-channels';
import type { MenuDeps } from './menu';

export function mergeViewMenuState(
  prev: EditorViewMenuStateSnapshot,
  partial: Partial<EditorViewMenuStateSnapshot>,
): EditorViewMenuStateSnapshot {
  return { ...prev, ...partial };
}

/**
 * The View-menu state main holds before the first renderer push lands.
 * Defaults match the renderer's resolved config defaults so the menu
 * reflects the right state at startup: Show hidden files + Show .ok
 * folders + Show only markdown files off, Show skills section on, both
 * Expand/Collapse rendered (no smart-hide), sidebar + doc panel assumed
 * visible (the common wide-window startup), terminal hidden with no live
 * session.
 */
export function createDefaultEditorViewMenuState(): EditorViewMenuStateSnapshot {
  return {
    showHiddenFiles: false,
    showOkFolders: false,
    showOnlyMarkdownFiles: false,
    showSkillsSection: true,
    canExpandAll: true,
    canCollapseAll: true,
    sidebarVisible: true,
    docPanelVisible: true,
    terminalVisible: false,
    terminalLive: false,
  };
}

/**
 * The slice of `MenuDeps` derived from the renderer-pushed snapshot plus the
 * menu-action dispatchers that round-trip back to the renderer. `Pick` keeps
 * every key checked against `MenuDeps` — a spread into the menu-install call
 * would let a misnamed field pass silently (spreads skip excess-property
 * checks).
 */
type ViewMenuStateDeps = Pick<
  MenuDeps,
  | 'showHiddenFilesChecked'
  | 'showOkFoldersChecked'
  | 'showOnlyMarkdownFilesChecked'
  | 'showSkillsSectionChecked'
  | 'canExpandAll'
  | 'canCollapseAll'
  | 'sidebarVisible'
  | 'docPanelVisible'
  | 'terminalVisible'
  | 'terminalLive'
  | 'onToggleShowHiddenFiles'
  | 'onToggleShowOkFolders'
  | 'onToggleShowOnlyMarkdownFiles'
  | 'onToggleShowSkillsSection'
  | 'onToggleSidebar'
  | 'onToggleDocPanel'
  | 'onToggleTerminal'
  | 'onNewTerminal'
  | 'onKillTerminal'
  | 'onExpandAll'
  | 'onCollapseAll'
>;

/**
 * Map the view-menu snapshot onto menu deps. Pure and separate from the
 * Electron entry point so the field/action wiring stays unit-testable — the
 * type mirrors pin the snapshot SHAPE, but nothing else checks that each
 * field lands on the right dep or that each toggle dispatches the right
 * menu-action ID.
 */
export function buildViewMenuStateDeps(
  state: EditorViewMenuStateSnapshot,
  sendMenuAction: (action: OkMenuAction) => void,
): ViewMenuStateDeps {
  return {
    showHiddenFilesChecked: state.showHiddenFiles,
    showOkFoldersChecked: state.showOkFolders,
    showOnlyMarkdownFilesChecked: state.showOnlyMarkdownFiles,
    showSkillsSectionChecked: state.showSkillsSection,
    canExpandAll: state.canExpandAll,
    canCollapseAll: state.canCollapseAll,
    sidebarVisible: state.sidebarVisible,
    docPanelVisible: state.docPanelVisible,
    terminalVisible: state.terminalVisible,
    terminalLive: state.terminalLive,
    onToggleShowHiddenFiles: () => sendMenuAction('toggle-show-hidden-files'),
    onToggleShowOkFolders: () => sendMenuAction('toggle-show-ok-folders'),
    onToggleShowOnlyMarkdownFiles: () => sendMenuAction('toggle-show-only-markdown-files'),
    onToggleShowSkillsSection: () => sendMenuAction('toggle-show-skills-section'),
    onToggleSidebar: () => sendMenuAction('toggle-sidebar'),
    onToggleDocPanel: () => sendMenuAction('toggle-doc-panel'),
    onToggleTerminal: () => sendMenuAction('toggle-terminal'),
    onNewTerminal: () => sendMenuAction('new-terminal'),
    onKillTerminal: () => sendMenuAction('kill-terminal'),
    onExpandAll: () => sendMenuAction('expand-all-tree'),
    onCollapseAll: () => sendMenuAction('collapse-all-tree'),
  };
}
