export interface SkillInstallOverlay {
  hosts: readonly string[] | null;
  source: string | null;
}

const EMPTY: SkillInstallOverlay = Object.freeze({ hosts: null, source: null });

const overlays = new Map<string, SkillInstallOverlay>();
const listeners = new Map<string, Set<() => void>>();

export function skillOverlayKey(scope: string, name: string): string {
  return `${scope}:${name}`;
}

export function getSkillOverlay(key: string): SkillInstallOverlay {
  return overlays.get(key) ?? EMPTY;
}

export function subscribeToSkillOverlay(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set<() => void>();
  listeners.set(key, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

export function setSkillOverlay(key: string, patch: Partial<SkillInstallOverlay>): void {
  const current = getSkillOverlay(key);
  const next: SkillInstallOverlay = { ...current, ...patch };
  if (next.hosts === current.hosts && next.source === current.source) return;
  if (next.hosts === null && next.source === null) overlays.delete(key);
  else overlays.set(key, next);
  for (const listener of listeners.get(key) ?? []) listener();
}

export function __resetSkillOverlaysForTests(): void {
  overlays.clear();
  for (const set of listeners.values()) for (const listener of set) listener();
}
