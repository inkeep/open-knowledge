let lastKnownSignedIn: boolean | null = null;

export function getLastKnownSignedIn(): boolean | null {
  return lastKnownSignedIn;
}

export function setLastKnownSignedIn(value: boolean | null): void {
  lastKnownSignedIn = value;
}
