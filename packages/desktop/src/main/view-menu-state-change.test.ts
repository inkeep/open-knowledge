import { describe, expect, test, vi } from 'vitest';
import { emptyState, getTerminalDockState, setTerminalDockState } from './state-store';
import { commitTerminalDockState } from './terminal-dock-persistence';
import { EditorViewMenuStateRegistry } from './view-menu-state';
import {
  handleViewMenuStateChange,
  type ViewMenuStateChangeDeps,
  type ViewMenuStateChangeInput,
} from './view-menu-state-change';

const panes = ['editorVisible', 'terminalVisible', 'agentPanelVisible'] as const;

type Pane = (typeof panes)[number];

function paneChange(
  pane: Pane,
  shown: boolean,
  intent: boolean,
): ViewMenuStateChangeInput['state'] {
  return { [pane]: shown, wideIntent: { [pane]: intent } } as ViewMenuStateChangeInput['state'];
}

function setup() {
  const menu = new EditorViewMenuStateRegistry();
  const editor = new Map<number, boolean>();
  const terminal = new Map<number, boolean>();
  const agents = new Map<number, boolean>();
  let durable = setTerminalDockState(emptyState(), '/file', {
    editorVisible: false,
    terminalVisible: false,
    agentPanelVisible: false,
    terminalSnapshot: { tabs: [], activeOrdinal: null },
  });
  const save = vi.fn(() => true);
  const warnPersistFailed = vi.fn();
  const refreshApplicationMenu = vi.fn();
  const deps: ViewMenuStateChangeDeps = {
    updateMenuState: (id, partial) => menu.update(id, partial),
    rememberEditorVisible: (id, visible) => editor.set(id, visible),
    rememberTerminalVisible: (id, visible) => terminal.set(id, visible),
    rememberAgentPanelVisible: (id, visible) => agents.set(id, visible),
    persist: (update) => {
      const result = commitTerminalDockState({
        current: durable,
        stateKey: '/file',
        update,
        save,
      });
      durable = result.state;
      return result.result;
    },
    warnPersistFailed,
    refreshApplicationMenu,
  };
  return {
    deps,
    menu,
    editor,
    terminal,
    agents,
    save,
    warnPersistFailed,
    refreshApplicationMenu,
    saved: () => getTerminalDockState(durable, '/file'),
  };
}

function push(
  deps: ViewMenuStateChangeDeps,
  state: ViewMenuStateChangeInput['state'],
  windowId: number | null = 7,
) {
  handleViewMenuStateChange({ windowId, state }, deps);
}

describe('desktop view menu state changes', () => {
  test('a narrow projection shows in the menu while the durable dock state keeps the wide intent', () => {
    const h = setup();
    for (const pane of panes) push(h.deps, paneChange(pane, true, false));

    expect(h.menu.get(7)).toMatchObject({
      editorVisible: true,
      terminalVisible: true,
      agentPanelVisible: true,
    });
    expect(h.saved()).toMatchObject({
      editorVisible: false,
      terminalVisible: false,
      agentPanelVisible: false,
    });
    expect(h.refreshApplicationMenu).toHaveBeenCalledTimes(3);
  });

  test('the wide intent the renderer reports is persisted and kept out of the menu state', () => {
    const h = setup();
    for (const pane of panes) push(h.deps, paneChange(pane, true, true));

    expect(h.menu.get(7)).toMatchObject({
      editorVisible: true,
      terminalVisible: true,
      agentPanelVisible: true,
    });
    expect(h.menu.get(7)).not.toHaveProperty('wideIntent');
    expect(h.saved()).toMatchObject({
      editorVisible: true,
      terminalVisible: true,
      agentPanelVisible: true,
    });
    expect(h.editor.get(7)).toBe(true);
    expect(h.terminal.get(7)).toBe(true);
    expect(h.agents.get(7)).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(3);
    expect(h.warnPersistFailed).not.toHaveBeenCalled();
  });

  test('closing the last session while narrow reaches the durable record and survives widening', () => {
    const h = setup();
    for (const pane of panes) push(h.deps, paneChange(pane, true, true));
    push(h.deps, paneChange('terminalVisible', false, false));
    push(h.deps, paneChange('agentPanelVisible', false, false));
    push(h.deps, paneChange('editorVisible', true, true));

    expect(h.saved()).toMatchObject({
      editorVisible: true,
      terminalVisible: false,
      agentPanelVisible: false,
    });
    expect(h.terminal.get(7)).toBe(false);
    expect(h.agents.get(7)).toBe(false);
  });

  test('a missing sender still refreshes the menu without a durable write', () => {
    const h = setup();
    push(h.deps, paneChange('terminalVisible', true, true), null);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.refreshApplicationMenu).toHaveBeenCalledOnce();
  });
});
