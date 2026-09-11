import type {
  OkUninstallBridge,
  UninstallDispatchResult,
  UninstallIntent,
} from '@inkeep/open-knowledge-core';

declare global {
  interface Window {
    okUninstall?: OkUninstallBridge;
  }
}

export type UninstallScreenResponse =
  | Extract<UninstallDispatchResult, { kind: 'screen' | 'refused' }>
  | {
      kind: 'unavailable';
      reason: 'missing-bridge' | 'request-failed' | 'timeout' | 'unexpected-response';
    };

export async function requestUninstallScreen(): Promise<UninstallScreenResponse> {
  const bridge = typeof window === 'undefined' ? undefined : window.okUninstall;
  if (bridge === undefined) return { kind: 'unavailable', reason: 'missing-bridge' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      bridge.ready(),
      new Promise<UninstallScreenResponse>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'unavailable', reason: 'timeout' }), 5000);
      }),
    ]);
    if (result.kind === 'accepted') return { kind: 'unavailable', reason: 'unexpected-response' };
    if (result.kind !== 'screen') console.warn('Uninstall screen unavailable', result.reason);
    return result;
  } catch (error) {
    console.warn('Uninstall screen request failed', error);
    return { kind: 'unavailable', reason: 'request-failed' };
  } finally {
    clearTimeout(timer);
  }
}

export function sendUninstallIntent(intent: UninstallIntent): void {
  const bridge = typeof window === 'undefined' ? undefined : window.okUninstall;
  if (bridge === undefined) return;
  void bridge.send(intent).catch(() => undefined);
}
