import type { OkDesktopBridge, OkTerminalRestartSnapshot } from '@/lib/desktop-bridge-types';

export type DockSurface = 'terminal' | 'agents';

export interface DockSessionOrder {
  readonly order: readonly string[];
  readonly activeKey: string | null;
}

export interface WebAgentsDockSessionOrder extends DockSessionOrder {
  readonly agentPanelVisible?: boolean;
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

function coerceOrder(raw: {
  order?: unknown;
  activeKey?: unknown;
  agentPanelVisible?: unknown;
}): WebAgentsDockSessionOrder {
  const order = Array.isArray(raw.order)
    ? raw.order.filter((k): k is string => typeof k === 'string')
    : [];
  const activeKey = typeof raw.activeKey === 'string' ? raw.activeKey : null;
  const agentPanelVisible =
    typeof raw.agentPanelVisible === 'boolean' ? raw.agentPanelVisible : undefined;
  return agentPanelVisible === undefined
    ? { order, activeKey }
    : { order, activeKey, agentPanelVisible };
}

type WebRecordRead =
  | { readonly status: 'absent' }
  | { readonly status: 'parsed'; readonly record: WebAgentsDockSessionOrder }
  | { readonly status: 'corrupt' }
  | { readonly status: 'blocked' };

function readWebRecord(surface: DockSurface): WebRecordRead {
  if (typeof window === 'undefined') return { status: 'absent' };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(WEB_STORAGE_KEYS[surface]);
  } catch (err) {
    console.warn(
      `[dock-session-persistence] reading ${WEB_STORAGE_KEYS[surface]} failed: ${String(err)}`,
    );
    return { status: 'blocked' };
  }
  if (raw === null) return { status: 'absent' };
  try {
    return {
      status: 'parsed',
      record: coerceOrder(
        JSON.parse(raw) as { order?: unknown; activeKey?: unknown; agentPanelVisible?: unknown },
      ),
    };
  } catch (err) {
    console.warn(
      `[dock-session-persistence] stored ${WEB_STORAGE_KEYS[surface]} record was not valid JSON; ignoring it: ${String(err)}`,
    );
    return { status: 'corrupt' };
  }
}

function mergeAgentsWebRecord(fields: {
  readonly order?: readonly string[];
  readonly activeKey?: string | null;
  readonly agentPanelVisible?: boolean;
}): WebAgentsDockSessionOrder | null {
  const read = readWebRecord('agents');
  if (read.status === 'blocked') {
    console.warn(
      `[dock-session-persistence] ${WEB_STORAGE_KEYS.agents} could not be read; withholding this write rather than overwriting the unread record`,
    );
    return null;
  }
  const current = read.status === 'parsed' ? read.record : null;
  const order = [...(fields.order ?? current?.order ?? [])];
  const activeKey =
    fields.activeKey !== undefined ? fields.activeKey : (current?.activeKey ?? null);
  const agentPanelVisible = fields.agentPanelVisible ?? current?.agentPanelVisible;
  return agentPanelVisible === undefined
    ? { order, activeKey }
    : { order, activeKey, agentPanelVisible };
}

export function readWebDockSessionOrder(surface: 'terminal'): DockSessionOrder | null;
export function readWebDockSessionOrder(surface: 'agents'): WebAgentsDockSessionOrder | null;
export function readWebDockSessionOrder(surface: DockSurface): DockSessionOrder | null;
export function readWebDockSessionOrder(surface: DockSurface): DockSessionOrder | null {
  const read = readWebRecord(surface);
  return read.status === 'parsed' ? read.record : null;
}

function writeWeb(surface: DockSurface, state: WebAgentsDockSessionOrder): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WEB_STORAGE_KEYS[surface], JSON.stringify(state));
  } catch (err) {
    console.warn(
      `[dock-session-persistence] writing ${WEB_STORAGE_KEYS[surface]} failed: ${String(err)}`,
    );
  }
}

export function writeAgentsPanelLevel(
  bridge: OkDesktopBridge | null | undefined,
  level: boolean,
): void {
  if (bridge?.terminal != null) return;
  const merged = mergeAgentsWebRecord({ agentPanelVisible: level });
  if (merged === null) return;
  writeWeb('agents', merged);
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

export function writeDockSessionOrder(
  bridge: OkDesktopBridge | null | undefined,
  surface: 'terminal',
  state: DockSessionOrder,
  terminalSnapshot?: OkTerminalRestartSnapshot,
): void;
export function writeDockSessionOrder(
  bridge: OkDesktopBridge | null | undefined,
  surface: 'agents',
  state: DockSessionOrder & { readonly agentPanelVisible?: never },
  terminalSnapshot?: OkTerminalRestartSnapshot,
): void;
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
  if (surface === 'agents') {
    const merged = mergeAgentsWebRecord({ order: state.order, activeKey: state.activeKey });
    if (merged === null) return;
    writeWeb('agents', merged);
    return;
  }
  writeWeb(surface, state);
}
