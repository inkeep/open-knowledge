export interface BackgroundThrottleSignal {
  hasPendingWork: boolean;
  enabled: boolean;
}

export function computeBackgroundThrottlingAllowed(signal: BackgroundThrottleSignal): boolean {
  return !(signal.enabled && signal.hasPendingWork);
}

export interface ThrottleableWebContents {
  isDestroyed(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
}

export function applyBackgroundThrottle(
  webContents: ThrottleableWebContents,
  signal: BackgroundThrottleSignal,
): void {
  if (webContents.isDestroyed()) return;
  webContents.setBackgroundThrottling(computeBackgroundThrottlingAllowed(signal));
}
