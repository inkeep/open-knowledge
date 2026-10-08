export interface ServerVersion {
  readonly runtimeVersion: string | null;
  readonly protocolVersion: number | null;
}

export interface ServerVersionChange {
  readonly loaded: ServerVersion;
  readonly current: ServerVersion;
  readonly drifted: boolean;
}

let loaded: ServerVersion | null = null;
let current: ServerVersion | null = null;
const listeners = new Set<(change: ServerVersionChange) => void>();

function sameServerVersion(a: ServerVersion, b: ServerVersion): boolean {
  return a.runtimeVersion === b.runtimeVersion && a.protocolVersion === b.protocolVersion;
}

export function observeServerVersion(observed: ServerVersion): void {
  if (loaded === null || current === null) {
    loaded = observed;
    current = observed;
    return;
  }
  if (sameServerVersion(current, observed)) return;
  current = observed;
  const change: ServerVersionChange = {
    loaded,
    current: observed,
    drifted: !sameServerVersion(loaded, observed),
  };
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (e) {
      console.warn('[server-version-store] subscriber threw:', e);
    }
  }
}

export function subscribeServerVersionChange(
  listener: (change: ServerVersionChange) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetServerVersionStoreForTests(): void {
  loaded = null;
  current = null;
  listeners.clear();
}
