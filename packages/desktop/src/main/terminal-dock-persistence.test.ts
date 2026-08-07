import { describe, expect, test, vi } from 'vitest';
import { emptyState, getTerminalDockState, setTerminalDockState } from './state-store';
import { commitTerminalDockState } from './terminal-dock-persistence';

describe('commitTerminalDockState', () => {
  test('publishes the new state only after the durable write succeeds', () => {
    const current = emptyState();
    const save = vi.fn(() => false);
    const outcome = commitTerminalDockState({
      current,
      stateKey: '/project',
      update: {
        terminalVisible: true,
        terminalSnapshot: {
          tabs: [{ ordinal: 1, customLabel: 'Build' }],
          activeOrdinal: 1,
        },
      },
      save,
    });

    expect(save).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ state: current, result: { ok: false, reason: 'persist-failed' } });
    expect(getTerminalDockState(outcome.state, '/project')).toEqual({
      terminalVisible: false,
      terminalSnapshot: { tabs: [], activeOrdinal: null },
    });
  });

  test('returns the committed state and explicit success after the write succeeds', () => {
    const outcome = commitTerminalDockState({
      current: emptyState(),
      stateKey: '/project',
      update: { terminalVisible: true },
      save: () => true,
    });

    expect(outcome.result).toEqual({ ok: true });
    expect(getTerminalDockState(outcome.state, '/project').terminalVisible).toBe(true);
  });

  test('skips the durable write when the normalized dock state is unchanged', () => {
    const terminalSnapshot = {
      tabs: [{ ordinal: 1, customLabel: 'Build' }],
      activeOrdinal: 1,
    };
    const current = setTerminalDockState(emptyState(), '/project', {
      terminalVisible: true,
      terminalSnapshot,
    });
    const save = vi.fn(() => true);

    const outcome = commitTerminalDockState({
      current,
      stateKey: '/project',
      update: { terminalSnapshot: structuredClone(terminalSnapshot) },
      save,
    });

    expect(save).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: current, result: { ok: true } });
  });
});
