import { describe, expect, test, vi } from 'vitest';
import {
  emptyState,
  getTerminalDockState,
  type PersistedTerminalDockState,
  setTerminalDockState,
} from './state-store';
import {
  applyAgentPanelVisibilityUpdate,
  commitTerminalDockState,
  resolveRestoredAgentPanelVisible,
} from './terminal-dock-persistence';

type LegacyDockState = Omit<PersistedTerminalDockState, 'agentPanelVisible'>;
type DockStateUpdate = { agentPanelVisible?: boolean; terminalVisible?: boolean };

const PROJECT = '/project';
const EMPTY_SNAPSHOT = { tabs: [], activeOrdinal: null };

describe('desktop persisted dock state — agents-panel visibility level', () => {
  test('an empty dock state defaults the agents-panel level to closed', () => {
    expect(getTerminalDockState(emptyState(), PROJECT).agentPanelVisible).toBe(false);
  });

  test('a legacy record without the agents-panel level parses to closed', () => {
    const legacy: LegacyDockState = {
      terminalVisible: true,
      terminalSnapshot: EMPTY_SNAPSHOT,
    };

    const state = setTerminalDockState(emptyState(), PROJECT, legacy as PersistedTerminalDockState);

    expect(getTerminalDockState(state, PROJECT).agentPanelVisible).toBe(false);
    expect(getTerminalDockState(state, PROJECT).terminalVisible).toBe(true);
    expect(getTerminalDockState(state, PROJECT).terminalSnapshot).toEqual(EMPTY_SNAPSHOT);
  });

  test('the agents-panel level survives the set-get round trip in both directions', () => {
    const open: PersistedTerminalDockState = {
      terminalVisible: false,
      terminalSnapshot: EMPTY_SNAPSHOT,
      agentPanelVisible: true,
    };
    const openState = setTerminalDockState(emptyState(), PROJECT, open);
    expect(getTerminalDockState(openState, PROJECT).agentPanelVisible).toBe(true);
    expect(getTerminalDockState(openState, PROJECT).terminalVisible).toBe(false);

    const closed: PersistedTerminalDockState = {
      terminalVisible: true,
      terminalSnapshot: EMPTY_SNAPSHOT,
      agentPanelVisible: false,
    };
    const closedState = setTerminalDockState(emptyState(), PROJECT, closed);
    expect(getTerminalDockState(closedState, PROJECT).agentPanelVisible).toBe(false);
    expect(getTerminalDockState(closedState, PROJECT).terminalVisible).toBe(true);
  });

  test('commitTerminalDockState persists the agents-panel level beside terminalVisible', () => {
    const update: DockStateUpdate = { terminalVisible: true, agentPanelVisible: true };

    const outcome = commitTerminalDockState({
      current: emptyState(),
      stateKey: PROJECT,
      update,
      save: () => true,
    });

    expect(outcome.result).toEqual({ ok: true });
    const dockState = getTerminalDockState(outcome.state, PROJECT);
    expect(dockState.agentPanelVisible).toBe(true);
    expect(dockState.terminalVisible).toBe(true);
  });

  test('recommitting an unchanged agents-panel level skips the durable write', () => {
    const first: DockStateUpdate = { agentPanelVisible: true };
    const committed = commitTerminalDockState({
      current: emptyState(),
      stateKey: PROJECT,
      update: first,
      save: () => true,
    });
    expect(committed.result).toEqual({ ok: true });

    const save = vi.fn(() => true);
    const second: DockStateUpdate = { agentPanelVisible: true };
    const outcome = commitTerminalDockState({
      current: committed.state,
      stateKey: PROJECT,
      update: second,
      save,
    });

    expect(save).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: committed.state, result: { ok: true } });
  });
});

describe('resolveRestoredAgentPanelVisible', () => {
  test('the in-memory level for a live window wins over the persisted record', () => {
    expect(
      resolveRestoredAgentPanelVisible({
        inMemory: true,
        persisted: {
          terminalVisible: false,
          terminalSnapshot: EMPTY_SNAPSHOT,
          agentPanelVisible: false,
        },
      }),
    ).toBe(true);
  });

  test('the persisted record is the fallback once the in-memory window map is gone', () => {
    expect(
      resolveRestoredAgentPanelVisible({
        inMemory: undefined,
        persisted: {
          terminalVisible: false,
          terminalSnapshot: EMPTY_SNAPSHOT,
          agentPanelVisible: true,
        },
      }),
    ).toBe(true);
    expect(
      resolveRestoredAgentPanelVisible({
        inMemory: undefined,
        persisted: {
          terminalVisible: false,
          terminalSnapshot: EMPTY_SNAPSHOT,
          agentPanelVisible: false,
        },
      }),
    ).toBe(false);
  });

  test('no record at all resolves to closed', () => {
    expect(resolveRestoredAgentPanelVisible({ inMemory: undefined, persisted: null })).toBe(false);
  });
});

describe('applyAgentPanelVisibilityUpdate', () => {
  test('a level update is remembered for the window and persisted', () => {
    const rememberForWindow = vi.fn();
    const persist = vi.fn(() => ({ ok: true }) as const);
    const warnPersistFailed = vi.fn();

    applyAgentPanelVisibilityUpdate({ rememberForWindow, persist, warnPersistFailed }, true);

    expect(rememberForWindow).toHaveBeenCalledWith(true);
    expect(persist).toHaveBeenCalledWith(true);
    expect(warnPersistFailed).not.toHaveBeenCalled();
  });

  test('a failed persist is surfaced as a warning', () => {
    const rememberForWindow = vi.fn();
    const persist = vi.fn(() => ({ ok: false, reason: 'persist-failed' }) as const);
    const warnPersistFailed = vi.fn();

    applyAgentPanelVisibilityUpdate({ rememberForWindow, persist, warnPersistFailed }, false);

    expect(rememberForWindow).toHaveBeenCalledWith(false);
    expect(persist).toHaveBeenCalledWith(false);
    expect(warnPersistFailed).toHaveBeenCalledWith('persist-failed');
  });
});
