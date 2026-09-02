import type { OkMenuAction, OkMenuActionOrigin } from './desktop-bridge-types';

type Listener = (action: OkMenuAction, origin: OkMenuActionOrigin) => void;

const LAUNCHER_FREE_ORIGIN: OkMenuActionOrigin = Object.freeze({ launcherBorne: false });

const listeners = new Set<Listener>();

let bridgeForwarderUnsubscribe: (() => void) | null = null;

function ensureBridgeForwarder(): void {
  if (bridgeForwarderUnsubscribe !== null) return;
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  if (bridge == null || typeof bridge.onMenuAction !== 'function') return;
  bridgeForwarderUnsubscribe = bridge.onMenuAction((action, origin) => {
    emitLocalMenuAction(action, origin);
  });
}

function teardownBridgeForwarderIfIdle(): void {
  if (listeners.size === 0 && bridgeForwarderUnsubscribe !== null) {
    bridgeForwarderUnsubscribe();
    bridgeForwarderUnsubscribe = null;
  }
}

export function subscribeLocalMenuAction(cb: Listener): () => void {
  listeners.add(cb);
  ensureBridgeForwarder();
  return () => {
    listeners.delete(cb);
    teardownBridgeForwarderIfIdle();
  };
}

export function emitLocalMenuAction(
  action: OkMenuAction,
  origin: OkMenuActionOrigin = LAUNCHER_FREE_ORIGIN,
): void {
  for (const cb of listeners) {
    try {
      cb(action, origin);
    } catch (err) {
      console.error('[local-menu-action-bus] subscriber threw during dispatch:', err);
    }
  }
}

export function __resetLocalMenuActionBusForTests(): void {
  listeners.clear();
  if (bridgeForwarderUnsubscribe !== null) {
    bridgeForwarderUnsubscribe();
    bridgeForwarderUnsubscribe = null;
  }
}
