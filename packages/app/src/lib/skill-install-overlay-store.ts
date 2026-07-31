/**
 * Module-level optimistic-install overlay, keyed by `scope:name`.
 *
 * A skill's install state is rendered by THREE surfaces at once — the editor
 * toolbar pill, the sidebar Install pill, and the sidebar three-dot submenu —
 * and each mounts its own `useSkillHostToggles`. With the overlay in component
 * state, toggling a row in one surface flipped only that surface: the pill next
 * to it kept reading server truth (a refetch behind) and read "Install" while
 * the menu already read "Installed". Hoisting the overlay here makes the click
 * land in ONE place every surface reads.
 *
 * `hosts: null` / `source: null` mean "no overlay — show server truth". The
 * hook clears an entry once the refetched skill catches up with it.
 */
export interface SkillInstallOverlay {
  /** Intended host set while an install is in flight. */
  hosts: readonly string[] | null;
  /** Intended source host while a source move is in flight. */
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

/**
 * Merge a patch into one skill's overlay. A no-op patch does NOT notify — the
 * convergence effects run in every mounted surface and would otherwise loop.
 */
export function setSkillOverlay(key: string, patch: Partial<SkillInstallOverlay>): void {
  const current = getSkillOverlay(key);
  const next: SkillInstallOverlay = { ...current, ...patch };
  if (next.hosts === current.hosts && next.source === current.source) return;
  if (next.hosts === null && next.source === null) overlays.delete(key);
  else overlays.set(key, next);
  for (const listener of listeners.get(key) ?? []) listener();
}

/** Test seam — drops every overlay so one test's in-flight state can't leak. */
export function __resetSkillOverlaysForTests(): void {
  overlays.clear();
  for (const set of listeners.values()) for (const listener of set) listener();
}
