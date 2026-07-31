/**
 * Reload-durable tab order for each session panel: the list of session keys in
 * tab order plus the active key. This is the ONE net-new persistence the panels
 * need — the order and active tab a renderer reload must restore. Everything
 * else already survives: terminal PTYs + their labels/ordinals in main, thread
 * liveness on the server, panel visibility in main.
 *
 * Recorded PER SURFACE. The terminal dock and the agents panel are independent
 * surfaces that persist on their own edges, so a single shared record would let
 * each panel's write erase the other's keys and clobber a shared active tab.
 *
 * Two backends behind one interface:
 *   - desktop: per-window main-process state (survives a renderer reload, is
 *     per-window so multi-window order never bleeds) via the terminal bridge;
 *   - web: best-effort localStorage (per-origin; multi-tab bleed is unsolved for
 *     both panels today and out of scope), since there is no main process.
 *
 * Keys are reload-STABLE identities, not the host's ephemeral client ids: a
 * terminal's ptyId (what `list()`/`adopt()` speak) and a thread's threadId (what
 * the server replays). The host maps its descriptors to these keys.
 */

import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

/** Which panel a persisted order belongs to. */
export type DockSurface = 'terminal' | 'agents';

export interface DockSessionOrder {
  /** Session keys (ptyIds for `terminal`, threadIds for `agents`) in tab order. */
  readonly order: readonly string[];
  /** The active session's key, or null when nothing is active. */
  readonly activeKey: string | null;
}

/** localStorage keys for the web backend — UI-pref stores like the other panel
 *  prefs (height, width), never a `config.yml` field. */
const WEB_STORAGE_KEYS: Record<DockSurface, string> = {
  terminal: 'ok-dock-session-order-v1',
  agents: 'ok-agent-session-order-v1',
};

/** Normalize a persisted record, dropping non-string keys. */
function coerceOrder(raw: { order?: unknown; activeKey?: unknown }): DockSessionOrder {
  const order = Array.isArray(raw.order)
    ? raw.order.filter((k): k is string => typeof k === 'string')
    : [];
  const activeKey = typeof raw.activeKey === 'string' ? raw.activeKey : null;
  return { order, activeKey };
}

/**
 * Synchronous localStorage read of one panel's web order (the mount seed reads
 * it before the async {@link readDockSessionOrder} would resolve). Returns
 * `null` when nothing is stored or storage is unavailable.
 */
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

/** Persist one panel's web order to localStorage (best-effort). */
function writeWeb(surface: DockSurface, state: DockSessionOrder): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WEB_STORAGE_KEYS[surface], JSON.stringify(state));
  } catch {
    // Quota / privacy mode — best-effort, the in-memory order still serves the session.
  }
}

/**
 * Read one panel's persisted order for this window/origin, or `null` when none
 * is retained (fresh launch, or a read failure — the caller cold-starts).
 * Desktop reads main's per-window state; web reads localStorage synchronously
 * (wrapped in a promise for one call shape).
 */
export function readDockSessionOrder(
  bridge: OkDesktopBridge | null | undefined,
  surface: DockSurface,
): Promise<DockSessionOrder | null> {
  if (typeof bridge?.terminal?.getDockState === 'function') {
    return bridge.terminal
      .getDockState()
      .then((state) => {
        const record = state[surface];
        if (record == null) return null;
        const { order, activeKey } = coerceOrder(record);
        // No retained order at all (fresh launch) reads as null so the caller
        // cold-starts rather than seeding an empty arrangement.
        return order.length === 0 && activeKey === null ? null : { order, activeKey };
      })
      .catch((err) => {
        // Cold-starting is the right fallback, but silence makes the three
        // failure modes (handler missing, main crashed, serialization) look
        // identical to "nothing was retained" — leaving a user report of "my
        // panel comes back empty" with nothing to grep for.
        console.warn('[dock-session-persistence] getDockState failed; cold-starting:', err);
        return null;
      });
  }
  return Promise.resolve(readWebDockSessionOrder(surface));
}

/** Persist one panel's order for this window/origin. Fire-and-forget on both backends. */
export function writeDockSessionOrder(
  bridge: OkDesktopBridge | null | undefined,
  surface: DockSurface,
  state: DockSessionOrder,
): void {
  if (typeof bridge?.terminal?.setDockState === 'function') {
    bridge.terminal.setDockState({
      surface,
      order: [...state.order],
      activeKey: state.activeKey,
    });
    return;
  }
  writeWeb(surface, state);
}
