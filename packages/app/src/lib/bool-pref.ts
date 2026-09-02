export function loadBoolPref(key: string, defaultValue = false): boolean {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return defaultValue;
    return stored === 'true';
  } catch {
    return defaultValue;
  }
}

export function saveBoolPref(key: string, value: boolean, defaultValue = false): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === defaultValue) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value ? 'true' : 'false');
    }
  } catch {}
}
