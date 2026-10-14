import type { OkTerminalDockStateWriteResult } from '@inkeep/open-knowledge-core/desktop-bridge';
import type {
  EditorViewMenuStateChange,
  EditorViewMenuStateSnapshot,
} from '../shared/ipc-channels';
import { applyDockVisibilityUpdate } from './terminal-dock-persistence';

type DockVisibilityUpdate = Partial<{
  editorVisible: boolean;
  terminalVisible: boolean;
  agentPanelVisible: boolean;
}>;

export interface ViewMenuStateChangeInput {
  readonly windowId: number | null;
  readonly state: EditorViewMenuStateChange;
}

export interface ViewMenuStateChangeDeps {
  readonly updateMenuState: (windowId: number, state: Partial<EditorViewMenuStateSnapshot>) => void;
  readonly rememberEditorVisible: (windowId: number, visible: boolean) => void;
  readonly rememberTerminalVisible: (windowId: number, visible: boolean) => void;
  readonly rememberAgentPanelVisible: (windowId: number, visible: boolean) => void;
  readonly persist: (update: DockVisibilityUpdate) => OkTerminalDockStateWriteResult;
  readonly warnPersistFailed: (kind: 'editor' | 'terminal' | 'agents', reason: string) => void;
  readonly refreshApplicationMenu: () => void;
}

export function handleViewMenuStateChange(
  { windowId, state }: ViewMenuStateChangeInput,
  deps: ViewMenuStateChangeDeps,
): void {
  const { wideIntent, ...menuState } = state;
  if (windowId !== null) deps.updateMenuState(windowId, menuState);
  if (windowId !== null && wideIntent?.editorVisible !== undefined) {
    applyDockVisibilityUpdate(
      {
        rememberForWindow: (visible) => deps.rememberEditorVisible(windowId, visible),
        persist: (visible) => deps.persist({ editorVisible: visible }),
        warnPersistFailed: (reason) => deps.warnPersistFailed('editor', reason),
      },
      wideIntent.editorVisible,
    );
  }
  if (windowId !== null && wideIntent?.terminalVisible !== undefined) {
    applyDockVisibilityUpdate(
      {
        rememberForWindow: (visible) => deps.rememberTerminalVisible(windowId, visible),
        persist: (visible) => deps.persist({ terminalVisible: visible }),
        warnPersistFailed: (reason) => deps.warnPersistFailed('terminal', reason),
      },
      wideIntent.terminalVisible,
    );
  }
  if (windowId !== null && wideIntent?.agentPanelVisible !== undefined) {
    applyDockVisibilityUpdate(
      {
        rememberForWindow: (visible) => deps.rememberAgentPanelVisible(windowId, visible),
        persist: (visible) => deps.persist({ agentPanelVisible: visible }),
        warnPersistFailed: (reason) => deps.warnPersistFailed('agents', reason),
      },
      wideIntent.agentPanelVisible,
    );
  }
  deps.refreshApplicationMenu();
}
