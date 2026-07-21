/**
 * Reload-durable dock order for the unified sessions dock: the interleaved list
 * of session keys (terminal ptyIds + thread threadIds, in tab order) plus the
 * active key. This is the ONE net-new persistence the unified dock needs — the
 * cross-kind order and active tab a renderer reload must restore. Everything else
 * already survives: terminal PTYs + their labels/ordinals in main, thread liveness
 * on the server, dock visibility in main, dock position in localStorage.
 *
 * Two backends behind one interface:
 *   - desktop: per-window main-process dock state (survives a renderer reload, is
 *     per-window so multi-window order never bleeds) via the terminal bridge;
 *   - web: best-effort localStorage (per-origin; multi-tab bleed is unsolved for
 *     both docks today and out of scope), since there is no main process.
 *
 * Keys are reload-STABLE identities, not the host's ephemeral client ids: a
 * terminal's ptyId (what `list()`/`adopt()` speak) and a thread's threadId (what
 * the server replays). The host maps its descriptors to these keys.
 */

import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export interface DockSessionOrder {
  /** Session keys (ptyIds + threadIds) in tab order. */
  readonly order: readonly string[];
  /** The active session's key, or null when nothing is active. */
  readonly activeKey: string | null;
}

/** localStorage key for the web backend — a UI-pref store like the other dock
 *  prefs (position, height, width), never a `config.yml` field. */
const WEB_STORAGE_KEY = 'ok-dock-session-order-v1';

/**
 * Synchronous localStorage read of the web dock order (the mount seed reads it
 * before the async {@link readDockSessionOrder} would resolve). Returns `null`
 * when nothing is stored or storage is unavailable.
 */
export function readWebDockSessionOrder(): DockSessionOrder | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(WEB_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { order?: unknown; activeKey?: unknown };
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((k): k is string => typeof k === 'string')
      : [];
    const activeKey = typeof parsed.activeKey === 'string' ? parsed.activeKey : null;
    return { order, activeKey };
  } catch {
    return null;
  }
}

/** Persist the web dock order to localStorage (best-effort). */
function writeWeb(state: DockSessionOrder): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota / privacy mode — best-effort, the in-memory order still serves the session.
  }
}

/**
 * Read the persisted dock order for this window/origin, or `null` when none is
 * retained (fresh launch, or a read failure — the caller cold-starts). Desktop
 * reads main's per-window dock state; web reads localStorage synchronously
 * (wrapped in a promise for one call shape).
 */
export function readDockSessionOrder(
  bridge: OkDesktopBridge | null | undefined,
): Promise<DockSessionOrder | null> {
  if (typeof bridge?.terminal?.getDockState === 'function') {
    return bridge.terminal
      .getDockState()
      .then((state) => {
        const order = Array.isArray(state.order)
          ? state.order.filter((k): k is string => typeof k === 'string')
          : [];
        const activeKey = typeof state.activeKey === 'string' ? state.activeKey : null;
        // No retained order at all (fresh launch) reads as null so the caller
        // cold-starts rather than seeding an empty arrangement.
        return order.length === 0 && activeKey === null ? null : { order, activeKey };
      })
      .catch(() => null);
  }
  return Promise.resolve(readWebDockSessionOrder());
}

/** Persist the dock order for this window/origin. Fire-and-forget on both backends. */
export function writeDockSessionOrder(
  bridge: OkDesktopBridge | null | undefined,
  state: DockSessionOrder,
): void {
  if (typeof bridge?.terminal?.setDockState === 'function') {
    bridge.terminal.setDockState({ order: [...state.order], activeKey: state.activeKey });
    return;
  }
  writeWeb(state);
}
