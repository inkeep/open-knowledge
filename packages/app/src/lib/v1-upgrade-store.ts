import { useSyncExternalStore } from 'react';
import type {
  OkDesktopBridge,
  OkV1UpgradeOptInResult,
  OkV1UpgradeSnapshot,
} from '@/lib/desktop-bridge-types';

export interface V1UpgradeUiState {
  readonly snapshot: OkV1UpgradeSnapshot | null;
  readonly dialogOpen: boolean;
  readonly dialogEverOpened: boolean;
}

const INITIAL_STATE: V1UpgradeUiState = {
  snapshot: null,
  dialogOpen: false,
  dialogEverOpened: false,
};

const FOCUS_FALLBACK_SELECTORS = [
  '[data-testid="v1-upgrade-header-pill"]',
  '[data-testid="v1-upgrade-about-review"]',
  '[data-testid="v1-upgrade-navigator-review"]',
  '[data-testid="v1-upgrade-toast-review"]',
  '[data-testid="header-settings-button"]',
] as const;

let state: V1UpgradeUiState = INITIAL_STATE;
const listeners = new Set<() => void>();
let attached = false;
let openerElement: HTMLElement | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function updateState(next: V1UpgradeUiState): void {
  state = next;
  notify();
}

export function shouldShowV1CornerToast(snapshot: OkV1UpgradeSnapshot | null): boolean {
  return Boolean(
    snapshot?.availableVersion &&
      snapshot.proactiveAllowed &&
      !snapshot.toastDismissed &&
      snapshot.phase !== 'ready',
  );
}

export function shouldShowV1HeaderPill(snapshot: OkV1UpgradeSnapshot | null): boolean {
  return Boolean(
    snapshot?.availableVersion &&
      ((snapshot.proactiveAllowed && snapshot.toastDismissed) || snapshot.phase === 'ready'),
  );
}

export function shouldShowV1NavigatorCard(snapshot: OkV1UpgradeSnapshot | null): boolean {
  return Boolean(
    snapshot?.availableVersion && (snapshot.proactiveAllowed || snapshot.phase === 'ready'),
  );
}

export function shouldShowV1AboutCard(snapshot: OkV1UpgradeSnapshot | null): boolean {
  return Boolean(snapshot?.availableVersion);
}

export function getV1UpgradeState(): V1UpgradeUiState {
  return state;
}

function subscribeV1UpgradeState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useV1UpgradeState(): V1UpgradeUiState {
  return useSyncExternalStore(subscribeV1UpgradeState, getV1UpgradeState, getV1UpgradeState);
}

export function openV1UpgradeDialog(): void {
  if (state.dialogOpen) return;
  openerElement =
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  updateState({ ...state, dialogOpen: true, dialogEverOpened: true });
}

export function closeV1UpgradeDialog(): void {
  if (!state.dialogOpen) return;
  updateState({ ...state, dialogOpen: false });
}

export function setV1UpgradeDialogOpen(dialogOpen: boolean): void {
  if (dialogOpen) {
    openV1UpgradeDialog();
  } else {
    closeV1UpgradeDialog();
  }
}

export function restoreV1UpgradeDialogFocus(): void {
  const candidate = openerElement;
  openerElement = null;
  if (candidate?.isConnected) {
    candidate.focus();
    return;
  }
  if (typeof document === 'undefined') return;
  for (const selector of FOCUS_FALLBACK_SELECTORS) {
    const fallback = document.querySelector<HTMLElement>(selector);
    if (fallback?.isConnected) {
      fallback.focus();
      return;
    }
  }
}

export function applyV1UpgradeSnapshot(snapshot: OkV1UpgradeSnapshot | null): void {
  updateState({ ...state, snapshot });
}

export function dismissV1UpgradeToast(bridgeOverride?: OkDesktopBridge): void {
  const bridge = bridgeOverride ?? (typeof window !== 'undefined' ? window.okDesktop : undefined);
  if (state.snapshot && !state.snapshot.toastDismissed) {
    updateState({
      ...state,
      snapshot: { ...state.snapshot, toastDismissed: true },
    });
  }
  bridge?.update.dismissV1Toast().catch((err: unknown) => {
    console.warn('[v1-upgrade-store] dismissV1Toast failed', err);
  });
}

export async function startV1UpgradeOptIn(
  bridgeOverride?: OkDesktopBridge,
): Promise<OkV1UpgradeOptInResult | null> {
  const bridge = bridgeOverride ?? (typeof window !== 'undefined' ? window.okDesktop : undefined);
  if (!bridge) return null;
  return bridge.update.optInV1Upgrade();
}

export function installV1UpgradeBridge(bridgeOverride?: OkDesktopBridge): () => void {
  const bridge = bridgeOverride ?? (typeof window !== 'undefined' ? window.okDesktop : undefined);
  if (!bridge) return () => {};
  if (!bridgeOverride && attached) return () => {};
  if (!bridgeOverride) attached = true;

  let cancelled = false;
  const querySnapshot = () => {
    bridge.state
      .query()
      .then((snapshot) => {
        if (cancelled) return;
        applyV1UpgradeSnapshot(snapshot.v1Upgrade);
      })
      .catch((err: unknown) => {
        console.warn('[v1-upgrade-store] bridge.state.query() failed', err);
      });
  };

  const unsubChanged = bridge.onV1UpgradeChanged((next) => {
    if (!cancelled) applyV1UpgradeSnapshot(next);
  });
  const unsubManualCheck = bridge.onUpdateManualCheck?.(({ phase }) => {
    if (phase === 'settled') querySnapshot();
  });

  querySnapshot();

  return () => {
    cancelled = true;
    unsubChanged();
    unsubManualCheck?.();
    if (!bridgeOverride) attached = false;
  };
}

export function resetV1UpgradeStoreForTests(): void {
  attached = false;
  openerElement = null;
  state = INITIAL_STATE;
  listeners.clear();
}
