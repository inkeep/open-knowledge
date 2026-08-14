/**
 * Pure handler for the `prefers-reduced-transparency` runtime path.
 *
 * The renderer's `ConfigProvider` matchMedia listener fires
 * `signalThemeApplied({ reducedTransparency })` whenever the user enables /
 * disables System Settings → Accessibility → Display → Reduce transparency.
 * Main observes through the existing `ok:theme:applied` IPC dispatch (the
 * payload is widened rather than adding a new channel — every additional
 * hand-rolled IPC channel is committed to trigger the typed-ipc framework
 * migration before it lands) and calls this handler to toggle vibrancy
 * material on every BrowserWindow.
 *
 * Architectural boundaries — three things this handler does NOT do:
 *   1. CSS-side fallback. The matching `@media (prefers-reduced-transparency:
 *      reduce)` block in globals.css reverts the alpha-aware outer canvas
 *      to solid `var(--sidebar)` — the renderer side is purely declarative
 *      and runs whether or not `window.okDesktop` is present.
 *   2. Material policy. Windows use the shared default unless their factory
 *      registers a preferred material for a native-chrome compatibility
 *      reason. The accessibility toggle still applies uniformly: reduced
 *      transparency disables every material.
 *   3. State.json caching. The preference is observed live via matchMedia
 *      and recovers on cold-launch by the same path; nothing to cache.
 *
 * The trust-boundary classification is unambiguous: data crosses the
 * renderer→main process seam, arrives via IPC marshaling, and the read
 * happens in the imperative shell — same boundary as `applyThemeSource`.
 * A guard on `isDestroyed?.()` is appropriate because
 * `BrowserWindow.getAllWindows()` may include a destroyed window between
 * the `closed` event and the next GC pass; calling `setVibrancy` on a
 * destroyed window throws in Electron.
 */

/** Vibrancy material narrowed to the values the desktop package actually uses. */
export type VibrancyMaterial = 'sidebar' | 'window';

/**
 * Structural subset of Electron's BrowserWindow surface used by this handler.
 * Tests inject mock objects implementing this shape; production wires the
 * real BrowserWindow via a structural cast (same precedent as
 * `BrowserWindowLike` in show-gate.ts).
 */
export interface BrowserWindowVibrancyTarget {
  /** Optional — Electron BrowserWindow exposes this synchronously. */
  isDestroyed?: () => boolean;
  /**
   * Electron BrowserWindow's stable integer id. Optional so test stubs may
   * omit it (then absent from the failure warn); production windows always
   * carry it, making a per-window `setVibrancy` failure attributable to a
   * specific window when one throws repeatedly.
   */
  readonly id?: number;
  setVibrancy: (mat: VibrancyMaterial | null) => void;
}

export interface ReducedTransparencyDeps {
  /** Snapshot of currently-open windows. Production wires `BrowserWindow.getAllWindows()`. */
  getAllWindows: () => readonly BrowserWindowVibrancyTarget[];
  /**
   * Vibrancy material to restore when reducedTransparency turns false. Pin
   * to the same value as `DEFAULT_WIN_OPTS.vibrancy` so the restored
   * material exactly matches the cold-launch material.
   */
  defaultVibrancy: VibrancyMaterial;
  /** Optional diagnostic sink for structured warn lines. Production wires console.warn. */
  warn?: (line: string) => void;
}

/**
 * Per-window memo of the last vibrancy material THIS handler applied. Lets
 * `applyReducedTransparency` skip a window already at the target material
 * instead of re-issuing `setVibrancy`.
 *
 * Why it exists: a theme change (light↔dark) re-sends the *unchanged*
 * `reducedTransparency` on every open window through the multiplexed
 * `ok:theme:applied` channel — yet the vibrancy material does NOT depend on
 * light/dark (it auto-tracks `nativeTheme.themeSource` at the
 * NSVisualEffectView level), so those re-applies are pure redundant work.
 * With N project windows open, one toggle propagates to all N (each fires the
 * signal) and each fan-out touches all N windows — N² `setVibrancy` calls in
 * a ~300 ms burst. On `transparent: true` windows every call rebuilds the
 * NSVisualEffectView, which visibly flickers the translucent chrome of the
 * non-focused windows. The memo collapses that burst to zero once each window
 * sits at the steady material.
 *
 * Keyed on window object identity (`BrowserWindow.getAllWindows()` returns
 * stable instances); a closed window is GC'd and its entry auto-drops. A new
 * window is absent from the map and so is applied once; a genuine
 * reduced-transparency toggle changes the material and so still fans out.
 *
 * Module-level (not a `deps` field) so every caller is idempotent for free —
 * no wiring to forget — and so the pure-DI dep surface stays unchanged.
 */
const lastAppliedMaterial = new WeakMap<BrowserWindowVibrancyTarget, VibrancyMaterial | null>();

/** Per-window native material exceptions registered by BrowserWindow factories. */
const preferredMaterial = new WeakMap<BrowserWindowVibrancyTarget, VibrancyMaterial>();

export function setPreferredWindowVibrancy(
  win: BrowserWindowVibrancyTarget,
  material: VibrancyMaterial,
): void {
  preferredMaterial.set(win, material);
}

/**
 * Apply the user's `prefers-reduced-transparency` preference to every open
 * BrowserWindow's vibrancy material, skipping windows already at the target
 * material (the per-window memo `lastAppliedMaterial` — see there for why the
 * redundant re-applies it suppresses would otherwise flicker the chrome).
 *
 * Each `setVibrancy` call is wrapped in a per-window try/catch so a throw on
 * any one window does not abort the loop. The `isDestroyed` guard handles
 * the common shutdown race; the catch isolates against the residual cases —
 * close events that fire between the guard and the native call, or
 * unexpected native errors surfaced through Electron's binding. Without it,
 * a throw mid-loop would leave earlier windows toggled and later windows
 * untouched, with no diagnostic trail because the summary warn follows the
 * loop.
 */
export function applyReducedTransparency(
  deps: ReducedTransparencyDeps,
  reducedTransparency: boolean,
): void {
  // Four-way partition of the windows we iterated: applied (windowCount) +
  // skipped (already at target) + failed (threw and was caught) + destroyed
  // (filtered mid-teardown). All four are emitted so the counts sum to
  // getAllWindows().length — a silently-failing window stays distinguishable
  // from the healthy converged state and from a transient teardown race.
  let windowCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let destroyedCount = 0;
  const vibrancyMaterials: Partial<Record<VibrancyMaterial | 'none', number>> = {};
  const recordMaterial = (material: VibrancyMaterial | null): void => {
    const key = material ?? 'none';
    vibrancyMaterials[key] = (vibrancyMaterials[key] ?? 0) + 1;
  };
  for (const win of deps.getAllWindows()) {
    if (win.isDestroyed?.() === true) {
      destroyedCount += 1;
      continue;
    }
    const material: VibrancyMaterial | null = reducedTransparency
      ? null
      : (preferredMaterial.get(win) ?? deps.defaultVibrancy);
    // Idempotence guard: skip a window already at the target material (see
    // `lastAppliedMaterial` for the flicker rationale). `material` is never
    // `undefined`, so the WeakMap's absent-key `undefined` reads as "never
    // applied to this window" and falls through to apply.
    if (lastAppliedMaterial.get(win) === material) {
      recordMaterial(material);
      skippedCount += 1;
      continue;
    }
    try {
      win.setVibrancy(material);
      // Memo only AFTER a successful native call — a throw leaves the window
      // unmemoized so the next pass re-attempts rather than skipping it.
      lastAppliedMaterial.set(win, material);
      recordMaterial(material);
      windowCount += 1;
    } catch (err) {
      failedCount += 1;
      deps.warn?.(
        JSON.stringify({
          event: 'reduced-transparency-window-failed',
          windowId: win.id,
          vibrancy: material,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  deps.warn?.(
    JSON.stringify({
      event: 'reduced-transparency-applied',
      reducedTransparency,
      vibrancy: reducedTransparency ? null : deps.defaultVibrancy,
      vibrancyMaterials,
      windowCount,
      skippedCount,
      failedCount,
      destroyedCount,
    }),
  );
}
