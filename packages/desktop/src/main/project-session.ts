import {
  type AppState,
  emptyProjectSessionState,
  getProjectSessionState,
  type ProjectSessionState,
  setProjectSessionState,
} from './state-store.ts';
import type { WindowManager } from './window-manager.ts';

type ProjectSessionContext = Pick<
  NonNullable<ReturnType<WindowManager['getContextForBrowserWindow']>>,
  'projectPath' | 'ephemeral'
>;

interface ProjectSessionDeps<Sender> {
  resolveContext: (sender: Sender) => ProjectSessionContext | null | undefined;
  getState: () => AppState;
  saveState: (state: AppState) => void;
}

export function createProjectSessionHandlers<Sender>(deps: ProjectSessionDeps<Sender>) {
  return {
    get(sender: Sender): ProjectSessionState {
      const context = deps.resolveContext(sender);
      if (!context || context.ephemeral) return emptyProjectSessionState();
      return getProjectSessionState(deps.getState(), context.projectPath);
    },
    set(sender: Sender, session: ProjectSessionState): void {
      const context = deps.resolveContext(sender);
      if (!context || context.ephemeral) return;
      deps.saveState(setProjectSessionState(deps.getState(), context.projectPath, session));
    },
  };
}
