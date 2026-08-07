import type { OkMenuAction } from '../shared/bridge-contract';
import type { EditorViewMenuStateSnapshot } from '../shared/ipc-channels';
import type { MenuDeps } from './menu';

export function mergeViewMenuState(
  prev: EditorViewMenuStateSnapshot,
  partial: Partial<EditorViewMenuStateSnapshot>,
): EditorViewMenuStateSnapshot {
  return { ...prev, ...partial };
}

export class EditorViewMenuStateRegistry {
  readonly #states = new Map<number, EditorViewMenuStateSnapshot>();
  #selectedWindowId: number | null = null;

  update(windowId: number, partial: Partial<EditorViewMenuStateSnapshot>): void {
    const previous = this.#states.get(windowId) ?? createDefaultEditorViewMenuState();
    this.#states.set(windowId, mergeViewMenuState(previous, partial));
    this.#selectedWindowId ??= windowId;
  }

  select(windowId: number): void {
    this.#selectedWindowId = windowId;
  }

  get(windowId: number): EditorViewMenuStateSnapshot {
    return this.#states.get(windowId) ?? createDefaultEditorViewMenuState();
  }

  current(focusedWindowId: number | null = null): EditorViewMenuStateSnapshot {
    const windowId = focusedWindowId ?? this.#selectedWindowId;
    return windowId === null ? createDefaultEditorViewMenuState() : this.get(windowId);
  }

  delete(windowId: number): void {
    this.#states.delete(windowId);
    if (this.#selectedWindowId === windowId) this.#selectedWindowId = null;
  }
}

/**
 * The View-menu state main holds before the first renderer push lands.
 * Defaults match the renderer's resolved config defaults so the menu
 * reflects the right state at startup: Show hidden files + Show .ok
 * folders + Show only markdown files off, Show skills section on, both
 * Expand/Collapse rendered (no smart-hide), sidebar + doc panel assumed
 * visible (the common wide-window startup), terminal hidden with no live
 * session, agents panel hidden.
 *
 * `canViewInSource` is the one field that defaults to the RESTRICTIVE value
 * rather than the likely one: it gates a context-menu row, and a row offered
 * before the renderer has said the jump is live would silently do nothing.
 * Absent is better than inert for a row the user has to read past.
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
    terminalPlacement: 'bottom',
    terminalLive: false,
    agentPanelVisible: false,
    canViewInSource: false,
    hasEditorSelection: false,
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
  | 'terminalPlacement'
  | 'terminalLive'
  | 'agentPanelVisible'
  | 'hasEditorSelection'
  | 'onToggleShowHiddenFiles'
  | 'onToggleShowOkFolders'
  | 'onToggleShowOnlyMarkdownFiles'
  | 'onToggleShowSkillsSection'
  | 'onToggleSidebar'
  | 'onToggleDocPanel'
  | 'onToggleTerminal'
  | 'onMoveTerminal'
  | 'onToggleAgentPanel'
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
    terminalPlacement: state.terminalPlacement,
    terminalLive: state.terminalLive,
    agentPanelVisible: state.agentPanelVisible,
    hasEditorSelection: state.hasEditorSelection,
    onToggleShowHiddenFiles: () => sendMenuAction('toggle-show-hidden-files'),
    onToggleShowOkFolders: () => sendMenuAction('toggle-show-ok-folders'),
    onToggleShowOnlyMarkdownFiles: () => sendMenuAction('toggle-show-only-markdown-files'),
    onToggleShowSkillsSection: () => sendMenuAction('toggle-show-skills-section'),
    onToggleSidebar: () => sendMenuAction('toggle-sidebar'),
    onToggleDocPanel: () => sendMenuAction('toggle-doc-panel'),
    onToggleTerminal: () => sendMenuAction('toggle-terminal'),
    onMoveTerminal: () => sendMenuAction('move-terminal'),
    onToggleAgentPanel: () => sendMenuAction('toggle-agent-panel'),
    onNewTerminal: () => sendMenuAction('new-terminal'),
    onKillTerminal: () => sendMenuAction('kill-terminal'),
    onExpandAll: () => sendMenuAction('expand-all-tree'),
    onCollapseAll: () => sendMenuAction('collapse-all-tree'),
  };
}
