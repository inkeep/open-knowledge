import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import {
  readWebDockSessionOrder,
  writeAgentsPanelLevel,
  writeDockSessionOrder,
} from './dock-session-persistence';
import { writeAgentsOrderFromStoredRecord } from './dock-session-persistence.agents-overload.test-helper';

describe('web dock store — agents-panel visibility level', () => {
  afterEach(() => {
    localStorage.clear();
  });

  test('a persisted closed panel level survives the write-read round trip', () => {
    writeDockSessionOrder(null, 'agents', { order: ['t1'], activeKey: 't1' });
    writeAgentsPanelLevel(null, false);

    expect(readWebDockSessionOrder('agents')?.agentPanelVisible).toBe(false);
    expect(readWebDockSessionOrder('agents')).toMatchObject({ order: ['t1'], activeKey: 't1' });
  });

  test('a persisted open panel level survives the write-read round trip', () => {
    writeDockSessionOrder(null, 'agents', { order: ['t1'], activeKey: 't1' });
    writeAgentsPanelLevel(null, true);

    expect(readWebDockSessionOrder('agents')?.agentPanelVisible).toBe(true);
  });

  test('a terminal-surface record carries no panel level', () => {
    writeDockSessionOrder(null, 'terminal', { order: ['pty-1'], activeKey: 'pty-1' });

    expect(readWebDockSessionOrder('terminal')).toEqual({
      order: ['pty-1'],
      activeKey: 'pty-1',
    });
    expect('agentPanelVisible' in (readWebDockSessionOrder('terminal') ?? {})).toBe(false);
  });

  test('a stored non-boolean panel level is dropped on read', () => {
    localStorage.setItem(
      'ok-agent-session-order-v1',
      JSON.stringify({ order: ['t1'], activeKey: 't1', agentPanelVisible: 'yes' }),
    );

    expect(readWebDockSessionOrder('agents')).toEqual({ order: ['t1'], activeKey: 't1' });
    expect('agentPanelVisible' in (readWebDockSessionOrder('agents') ?? {})).toBe(false);
  });

  test('a quota-failed level write resolves without throwing and warns with the failing key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });

    expect(() => writeAgentsPanelLevel(null, true)).not.toThrow();
    expect(String(warn.mock.calls[0]?.[0])).toContain('writing ok-agent-session-order-v1 failed');

    setItem.mockRestore();
    warn.mockRestore();
  });

  test('a stored unparseable record warns it is being ignored and reads as absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('ok-agent-session-order-v1', 'not json');

    expect(readWebDockSessionOrder('agents')).toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toContain('not valid JSON');

    warn.mockRestore();
  });

  test('an order-only write preserves the stored panel level', () => {
    writeAgentsPanelLevel(null, true);

    writeDockSessionOrder(null, 'agents', { order: ['t1'], activeKey: 't1' });

    expect(readWebDockSessionOrder('agents')?.agentPanelVisible).toBe(true);
    expect(readWebDockSessionOrder('agents')).toMatchObject({ order: ['t1'], activeKey: 't1' });
  });

  test('a corrupt stored record does not cancel the level write', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('ok-agent-session-order-v1', 'not json');

    writeAgentsPanelLevel(null, true);

    expect(readWebDockSessionOrder('agents')?.agentPanelVisible).toBe(true);
    warn.mockRestore();
  });

  test('a level write over a record that could not be read is withheld and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stored = JSON.stringify({ order: ['t1'], activeKey: 't1', agentPanelVisible: false });
    localStorage.setItem('ok-agent-session-order-v1', stored);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    writeAgentsPanelLevel(null, true);

    getItem.mockRestore();
    expect(localStorage.getItem('ok-agent-session-order-v1')).toBe(stored);
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes(
          'ok-agent-session-order-v1 could not be read; withholding this write rather than overwriting the unread record',
        ),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  test('an order write over a record that could not be read is withheld and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stored = JSON.stringify({ order: ['t1'], activeKey: 't1', agentPanelVisible: true });
    localStorage.setItem('ok-agent-session-order-v1', stored);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    writeDockSessionOrder(null, 'agents', { order: ['t2'], activeKey: 't2' });

    getItem.mockRestore();
    expect(localStorage.getItem('ok-agent-session-order-v1')).toBe(stored);
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes(
          'ok-agent-session-order-v1 could not be read; withholding this write rather than overwriting the unread record',
        ),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  test('an order write cannot carry a caller-supplied panel level past the stored one', () => {
    writeAgentsPanelLevel(null, false);

    writeAgentsOrderFromStoredRecord({ order: ['t1'], activeKey: 't1', agentPanelVisible: true });

    expect(readWebDockSessionOrder('agents')).toEqual({
      order: ['t1'],
      activeKey: 't1',
      agentPanelVisible: false,
    });
  });

  test('a desktop terminal bridge keeps the level write off the web record', () => {
    const bridge = { terminal: {} } as unknown as OkDesktopBridge;
    localStorage.setItem(
      'ok-agent-session-order-v1',
      JSON.stringify({ order: ['t1'], activeKey: 't1', agentPanelVisible: true }),
    );

    writeAgentsPanelLevel(bridge, false);

    expect(readWebDockSessionOrder('agents')?.agentPanelVisible).toBe(true);
    expect(readWebDockSessionOrder('agents')).toMatchObject({ order: ['t1'], activeKey: 't1' });
  });

  test('a bridge-backed agents write pins the setDockState payload to order and activeKey', () => {
    const setDockState = vi.fn(() => ({ ok: true as const }));
    const bridge = { terminal: { setDockState } } as unknown as OkDesktopBridge;

    writeDockSessionOrder(bridge, 'agents', { order: ['t2', 't1'], activeKey: 't2' });

    expect(setDockState).toHaveBeenCalledTimes(1);
    expect(setDockState.mock.calls[0]?.[0]).toEqual({
      surface: 'agents',
      order: ['t2', 't1'],
      activeKey: 't2',
    });
    expect('agentPanelVisible' in (setDockState.mock.calls[0]?.[0] ?? {})).toBe(false);
  });
});
