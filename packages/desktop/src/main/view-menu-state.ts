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
