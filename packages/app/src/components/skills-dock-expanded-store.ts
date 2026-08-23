/**
 * Whether the Skills dock at the bottom of the sidebar is expanded.
 *
 * Machine-local UI state, not project config: two people sharing a repo have no
 * reason to share a panel's open/closed state, and the project config CRDT is
 * the wrong place for something that changes on every click. Mirrors the
 * storage shape of `skills-section-visible-cache` (its sibling), which caches
 * the separate *visibility* preference — that one IS project config, and it
 * hides the dock outright rather than folding it.
 *
 * Ships collapsed. That is load-bearing beyond layout: `SkillsSidebarSection`
 * gates a detected-skills scan and an N-per-skill bundle-file fetch on being
 * expanded, so a user who never opens the dock never pays for either.
 *
 * `read` / `write` / `subscribe` is `terminal-new-tab-store`'s naming, taken
 * verbatim — the closest sibling, being the other machine-local UI-state store
 * with the same shape. The `get` / `subscribeTo` / `request` set elsewhere
 * belongs to the event-ish stores (a prompt is requested and cleared, not read).
 */
const STORAGE_KEY = 'ok-skills-dock-expanded-v1';

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// undefined = not yet read from storage this session.
let cached: boolean | undefined;

export function readSkillsDockExpanded(): boolean {
  if (cached === undefined) {
    cached = storage()?.getItem(STORAGE_KEY) === 'true';
  }
  return cached;
}

const listeners = new Set<(expanded: boolean) => void>();

export function writeSkillsDockExpanded(expanded: boolean): void {
  if (cached === expanded) return;
  cached = expanded;
  try {
    storage()?.setItem(STORAGE_KEY, expanded ? 'true' : 'false');
  } catch {
    // quota / privacy mode — the in-memory value still serves this session.
  }
  for (const listener of listeners) listener(expanded);
}

/**
 * Subscribe the mounted dock to writes made from outside it — the command
 * palette's Skills entry and an unresolved `/skill-name` link both ask for the
 * dock rather than a page, now that the Skills home is gone. Without this the
 * dock would only observe its own clicks, since it reads the store once at mount.
 */
export function subscribeSkillsDockExpanded(listener: (expanded: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reveal the dock from a surface that has no other way to reach it. */
export function requestSkillsDockExpanded(): void {
  writeSkillsDockExpanded(true);
}

/** Test-only: how many subscribers are registered. React 19 silently ignores
 *  setState on an unmounted component, so a leaked subscription is otherwise
 *  unobservable from the outside — this is the only honest unmount assertion. */
export function __skillsDockListenerCountForTests(): number {
  return listeners.size;
}

/** Test-only: reset to the never-set state (collapsed), storage included. */
export function __resetSkillsDockExpandedForTests(): void {
  cached = undefined;
  cachedHeight = undefined;
  try {
    storage()?.removeItem(STORAGE_KEY);
    storage()?.removeItem(HEIGHT_KEY);
  } catch {
    // no storage in this environment — the in-memory reset above is enough.
  }
}

/**
 * The dock's dragged height in px, or `null` for "never dragged" — which renders
 * at the default cap rather than at a number, so the dock keeps sizing itself to
 * the viewport until the user has an opinion.
 */
const HEIGHT_KEY = 'ok-skills-dock-height-v1';

/** Floor and ceiling for a dragged height. The floor keeps the panel from being
 *  dragged into a sliver that reads as broken; the ceiling is a fraction of the
 *  viewport rather than a constant so the file tree above always keeps a body. */
export const SKILLS_DOCK_MIN_HEIGHT = 96;
export function skillsDockMaxHeight(viewportHeight: number): number {
  return Math.max(SKILLS_DOCK_MIN_HEIGHT, Math.round(viewportHeight * 0.7));
}
export function clampSkillsDockHeight(height: number, viewportHeight: number): number {
  return Math.min(
    Math.max(Math.round(height), SKILLS_DOCK_MIN_HEIGHT),
    skillsDockMaxHeight(viewportHeight),
  );
}

// undefined = not yet read this session; null = stored as "never dragged".
let cachedHeight: number | null | undefined;

export function readSkillsDockHeight(): number | null {
  if (cachedHeight === undefined) {
    const raw = storage()?.getItem(HEIGHT_KEY);
    const parsed = raw === null || raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    cachedHeight = Number.isFinite(parsed) ? parsed : null;
  }
  return cachedHeight;
}

export function writeSkillsDockHeight(height: number): void {
  cachedHeight = height;
  try {
    storage()?.setItem(HEIGHT_KEY, String(height));
  } catch {
    // quota / privacy mode — the in-memory value still serves this session.
  }
}
