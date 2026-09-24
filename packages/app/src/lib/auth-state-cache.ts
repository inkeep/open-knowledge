let lastKnownSignedIn: boolean | null = null;

export function getLastKnownSignedIn(): boolean | null {
  return lastKnownSignedIn;
}

export function setLastKnownSignedIn(value: boolean | null): void {
  lastKnownSignedIn = value;
}

export function recordAuthStatus(status: {
  authenticated: boolean;
  unsupportedOrigin?: unknown;
}): void {
  if (!status.authenticated && status.unsupportedOrigin !== undefined) return;
  lastKnownSignedIn = status.authenticated;
}
