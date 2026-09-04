let lastCrashKey: string | null = null;
let suppressNextRestore = false;
let suppressNextHashNavigation = false;

function crashKey(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function recordAppShellCrashTrip(error: unknown): void {
  const key = crashKey(error);
  if (key === lastCrashKey) {
    suppressNextRestore = true;
    suppressNextHashNavigation = true;
    return;
  }
  lastCrashKey = key;
  suppressNextRestore = false;
  suppressNextHashNavigation = false;
}

export function shouldSuppressTabSessionRestore(): boolean {
  return suppressNextRestore;
}

export function resetTabSessionRestoreSuppression(): void {
  suppressNextRestore = false;
  lastCrashKey = null;
}

export function consumeHashNavigationSuppression(): boolean {
  const armed = suppressNextHashNavigation;
  suppressNextHashNavigation = false;
  return armed;
}
