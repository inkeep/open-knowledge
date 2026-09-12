import { describe, expect, test, vi } from 'vitest';
import { createProjectSessionHandlers } from './project-session.ts';
import {
  emptyProjectSessionState,
  emptyState,
  type ProjectSessionState,
  setProjectSessionState,
} from './state-store.ts';

function sessionWithTab(tabId: string): ProjectSessionState {
  const session = emptyProjectSessionState();
  return {
    ...session,
    panes: session.panes.map((pane) => ({
      ...pane,
      openTabs: [tabId],
      activeTabId: tabId,
    })),
  };
}

function createHarness() {
  const contexts = {
    firstFile: {
      projectPath: '/notes',
      ephemeral: { projectDir: '/tmp/first-file', pid: 11, lockDir: '/tmp/first-file/.ok/local' },
    },
    secondFile: {
      projectPath: '/notes',
      ephemeral: { projectDir: '/tmp/second-file', pid: 12, lockDir: '/tmp/second-file/.ok/local' },
    },
    project: { projectPath: '/notes' },
    otherProject: { projectPath: '/other' },
    unbound: null,
  };
  let state = emptyState();
  const saveState = vi.fn((next: typeof state) => {
    state = next;
  });
  return {
    handlers: createProjectSessionHandlers({
      resolveContext: (sender: keyof typeof contexts) => contexts[sender],
      getState: () => state,
      saveState,
    }),
    saveState,
    getState: () => state,
    seed: (session: ProjectSessionState) => {
      state = setProjectSessionState(state, '/notes', session);
    },
  };
}

describe('project session handlers', () => {
  test('opening a second standalone file does not restore the first file tab', () => {
    const { handlers, saveState } = createHarness();
    handlers.set('firstFile', sessionWithTab('first'));
    expect(handlers.get('secondFile')).toEqual(emptyProjectSessionState());
    expect(saveState).not.toHaveBeenCalled();
  });

  test('standalone files ignore saved sibling tabs from older app versions', () => {
    const { handlers, seed } = createHarness();
    seed(sessionWithTab('old-sibling'));
    expect(handlers.get('firstFile')).toEqual(emptyProjectSessionState());
    expect(handlers.get('secondFile')).toEqual(emptyProjectSessionState());
  });

  test('standalone files cannot overwrite a project session in their parent directory', () => {
    const { handlers, seed, getState, saveState } = createHarness();
    const projectSession = sessionWithTab('project-note');
    seed(projectSession);
    const before = getState();
    handlers.set('firstFile', sessionWithTab('first'));
    handlers.set('secondFile', sessionWithTab('second'));
    expect(getState()).toBe(before);
    expect(handlers.get('project')).toEqual(projectSession);
    expect(saveState).not.toHaveBeenCalled();
  });

  test('project windows persist and restore tabs independently', () => {
    const { handlers, saveState } = createHarness();
    const first = sessionWithTab('project-note');
    const second = sessionWithTab('other-note');
    handlers.set('project', first);
    handlers.set('otherProject', second);
    expect(handlers.get('project')).toEqual(first);
    expect(handlers.get('otherProject')).toEqual(second);
    expect(saveState).toHaveBeenCalledTimes(2);
  });

  test('a window without a project context has no persisted session', () => {
    const { handlers, saveState } = createHarness();
    expect(handlers.get('unbound')).toEqual(emptyProjectSessionState());
    handlers.set('unbound', sessionWithTab('orphan'));
    expect(saveState).not.toHaveBeenCalled();
  });
});
