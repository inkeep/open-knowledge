import { useSyncExternalStore } from 'react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

let relaunchInFlight = false;
const listeners = new Set<() => void>();
let attached = false;

function notify(): void {
  for (const l of listeners) l();
}

function setInFlight(next: boolean): void {
  if (relaunchInFlight === next) return;
  relaunchInFlight = next;
  notify();
}

export function getRelaunchInFlightSnapshot(): boolean {
  return relaunchInFlight;
}

export function subscribeRelaunchInFlight(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function attachRelaunchStateSubscribers(
  bridge: Pick<OkDesktopBridge, 'onUpdateRelaunching' | 'onUpdateRelaunchFailed'>,
): () => void {
  const offs = [
    bridge.onUpdateRelaunching(() => setInFlight(true)),
    bridge.onUpdateRelaunchFailed(() => setInFlight(false)),
  ];
  return () => {
    for (const off of offs) off();
  };
}

export function installRelaunchStateBridge(): void {
  if (attached) return;
  if (typeof window === 'undefined') return;
  const bridge = window.okDesktop;
  if (!bridge) return;
  attached = true;
  attachRelaunchStateSubscribers(bridge);
}

export function useRelaunchInFlight(): boolean {
  return useSyncExternalStore(subscribeRelaunchInFlight, getRelaunchInFlightSnapshot, () => false);
}

export function resetRelaunchStoreForTest(): void {
  relaunchInFlight = false;
  attached = false;
  listeners.clear();
}
