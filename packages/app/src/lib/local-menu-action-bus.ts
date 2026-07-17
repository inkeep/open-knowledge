import type { OkMenuAction } from './desktop-bridge-types';

/**
 * Renderer-local fan-out for menu actions, so both invocation surfaces converge
 * on ONE dispatch path per window:
 *
 *  - Native menu → main sends `ok:menu-action` → a single forwarder (installed
 *    here, ref-counted) re-emits it onto this bus.
 *  - Cmd+K command palette → emits directly onto this bus for id-backed commands.
 *
 * Every renderer subscriber (FileSidebar, EditorArea, EditorPane, …) listens on
 * this bus instead of `bridge.onMenuAction` directly. That decoupling is what
 * makes host-agnostic commands (view/panel/tree toggles) reachable from the
 * palette on the WEB host, where `window.okDesktop` is absent and no bridge
 * listener exists: the forwarder simply never installs and the palette's direct
 * emit still reaches every subscriber.
 *
 * The forwarder is the ONLY remaining `bridge.onMenuAction` listener (precedent:
 * one inbound path). No subscriber listens on both the bridge and this bus, so a
 * real menu click fires each handler exactly once (no double-fire).
 */

type Listener = (action: OkMenuAction) => void;

const listeners = new Set<Listener>();

// The single `bridge.onMenuAction` forwarder. Installed lazily when the first
// subscriber attaches and torn down when the last detaches, so the bus owns the
// bridge wiring rather than every window root having to install it.
let bridgeForwarderUnsubscribe: (() => void) | null = null;

function ensureBridgeForwarder(): void {
  if (bridgeForwarderUnsubscribe !== null) return;
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  // Web host (or pre-preload): no bridge to forward from. The palette still
  // emits directly onto the bus, so host-agnostic subscribers keep working.
  // A partial bridge (session-only host, or a test stub) may not expose
  // `onMenuAction` — guard so the forwarder never throws on a truthy-but-thin
  // `window.okDesktop`; direct palette emits still reach every subscriber.
  if (bridge == null || typeof bridge.onMenuAction !== 'function') return;
  bridgeForwarderUnsubscribe = bridge.onMenuAction((action) => {
    emitLocalMenuAction(action);
  });
}

function teardownBridgeForwarderIfIdle(): void {
  if (listeners.size === 0 && bridgeForwarderUnsubscribe !== null) {
    bridgeForwarderUnsubscribe();
    bridgeForwarderUnsubscribe = null;
  }
}

/**
 * Subscribe to menu actions delivered on this window's bus. Returns an
 * unsubscribe closure with the same contract as `bridge.onMenuAction` (call it
 * on effect cleanup / unmount), so a migrating subscriber is a drop-in swap.
 */
export function subscribeLocalMenuAction(cb: Listener): () => void {
  listeners.add(cb);
  ensureBridgeForwarder();
  return () => {
    listeners.delete(cb);
    teardownBridgeForwarderIfIdle();
  };
}

/**
 * Fan an action out to every current subscriber synchronously. The palette
 * calls this for id-backed commands; the inbound-IPC forwarder calls it for
 * native menu clicks. Iterates the live subscriber set — JS Set iteration
 * tolerates a subscriber that unsubscribes itself mid-dispatch; a subscriber
 * must not synchronously unsubscribe a sibling from within its handler.
 */
export function emitLocalMenuAction(action: OkMenuAction): void {
  // Iterate the live set: JS Set iteration tolerates a subscriber that
  // unsubscribes itself mid-dispatch. Subscribers must not synchronously
  // unsubscribe a sibling during their handler.
  for (const cb of listeners) {
    try {
      cb(action);
    } catch (err) {
      // Isolate subscriber faults: this bus is the single dispatch path for
      // native menu clicks AND palette commands, so one throwing handler must
      // not silently starve every subscriber after it in insertion order.
      console.error('[local-menu-action-bus] subscriber threw during dispatch:', err);
    }
  }
}

/**
 * Test-only reset — clears subscribers and drops the bridge forwarder so each
 * test starts from a clean module singleton. Not part of the runtime contract.
 */
export function __resetLocalMenuActionBusForTests(): void {
  listeners.clear();
  if (bridgeForwarderUnsubscribe !== null) {
    bridgeForwarderUnsubscribe();
    bridgeForwarderUnsubscribe = null;
  }
}
