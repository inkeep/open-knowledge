import type { OkDesktopBridge, OkTerminalRestartSnapshot } from '@/lib/desktop-bridge-types';

export type DockSurface = 'terminal' | 'agents';

export interface DockSessionOrder {
  readonly order: readonly string[];
  readonly activeKey: string | null;
}

export interface DockRestoreState {
  readonly sessionOrder: DockSessionOrder | null;
  readonly terminalSnapshot: OkTerminalRestartSnapshot | undefined;
  readonly failed: boolean;
}

const WEB_STORAGE_KEYS: Record<DockSurface, string> = {
  terminal: 'ok-dock-session-order-v1',
  agents: 'ok-agent-session-order-v1',
};

function coerceOrder(raw: { order?: unknown; activeKey?: unknown }): DockSessionOrder {
  const order = Array.isArray(raw.order)
    ? raw.order.filter((k): k is string => typeof k === 'string')
    : [];
  const activeKey = typeof raw.activeKey === 'string' ? raw.activeKey : null;
  return { order, activeKey };
}

export function readWebDockSessionOrder(surface: DockSurface): DockSessionOrder | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(WEB_STORAGE_KEYS[surface]);
    if (raw === null) return null;
    return coerceOrder(JSON.parse(raw) as { order?: unknown; activeKey?: unknown });
  } catch {
    return null;
  }
}

function writeWeb(surface: DockSurface, state: DockSessionOrder): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WEB_STORAGE_KEYS[surface], JSON.stringify(state));
  } catch {}
}

export async function readDockRestoreState(
  bridge: OkDesktopBridge | null | undefined,
  surface: DockSurface,
): Promise<DockRestoreState> {
  if (typeof bridge?.terminal?.getDockState === 'function') {
    try {
      const state = await bridge.terminal.getDockState();
      const record = state[surface];
      if (record == null) {
        return { sessionOrder: null, terminalSnapshot: state.terminalSnapshot, failed: false };
      }
      const { order, activeKey } = coerceOrder(record);
      const sessionOrder = order.length === 0 && activeKey === null ? null : { order, activeKey };
      return { sessionOrder, terminalSnapshot: state.terminalSnapshot, failed: false };
    } catch (err) {
      console.warn(`[dock-session-persistence] getDockState failed; cold-starting: ${String(err)}`);
      return { sessionOrder: null, terminalSnapshot: undefined, failed: true };
    }
  }

  return {
    sessionOrder: bridge?.terminal == null ? readWebDockSessionOrder(surface) : null,
    terminalSnapshot: undefined,
    failed: false,
  };
}

export function readDockSessionOrder(
  bridge: OkDesktopBridge | null | undefined,
  surface: DockSurface,
): Promise<DockSessionOrder | null> {
  return readDockRestoreState(bridge, surface).then((state) => state.sessionOrder);
}

export function writeDockSessionOrder(
  bridge: OkDesktopBridge | null | undefined,
  surface: DockSurface,
  state: DockSessionOrder,
  terminalSnapshot: OkTerminalRestartSnapshot = { tabs: [], activeOrdinal: null },
): void {
  if (typeof bridge?.terminal?.setDockState === 'function') {
    const sessionState = {
      order: [...state.order],
      activeKey: state.activeKey,
    };
    const write =
      surface === 'terminal'
        ? bridge.terminal.setDockState({ surface: 'terminal', ...sessionState, terminalSnapshot })
        : bridge.terminal.setDockState({ surface: 'agents', ...sessionState });
    void Promise.resolve(write)
      .then((result) => {
        if (result?.ok === false) {
          if (result.reason === 'ipc-unavailable') {
            console.warn('[dock-session-persistence] setDockState skipped during window teardown');
          } else {
            console.error(`[dock-session-persistence] setDockState failed: ${result.reason}`);
          }
        }
      })
      .catch((err: unknown) => {
        console.error(
          `[dock-session-persistence] setDockState rejected: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      });
    return;
  }
  if (bridge?.terminal != null) return;
  writeWeb(surface, state);
}
