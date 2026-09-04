import type {
  OkUninstallBridge,
  UninstallIntent,
  UninstallScreenSpec,
} from '@inkeep/open-knowledge-core';

declare global {
  interface Window {
    okUninstall?: OkUninstallBridge;
  }
}

export async function requestUninstallScreen(): Promise<UninstallScreenSpec | null> {
  const bridge = typeof window === 'undefined' ? undefined : window.okUninstall;
  if (bridge === undefined) return null;
  try {
    const result = await bridge.ready();
    return result.kind === 'screen' ? result.screen : null;
  } catch {
    return null;
  }
}

export function sendUninstallIntent(intent: UninstallIntent): void {
  const bridge = typeof window === 'undefined' ? undefined : window.okUninstall;
  if (bridge === undefined) return;
  void bridge.send(intent).catch(() => undefined);
}
