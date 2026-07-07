/**
 * Pure handler for `ok:theme:set-source` IPC. Sets nativeTheme.themeSource
 * to the renderer's user-intent value and emits a structured warn for
 * operator diagnostics.
 *
 * Architectural boundaries — three things this handler does NOT do:
 *   1. setBackgroundColor fan-out across BrowserWindows. Under
 *      `transparent: true` + vibrancy (the new chrome treatment),
 *      setBackgroundColor is a no-op; vibrancy material auto-tracks
 *      nativeTheme.themeSource via Electron's NSVisualEffectView wiring.
 *   2. state.json write. themeSource is not cached — cold-launch chrome
 *      correctness comes from the show-gate, which holds window.show()
 *      until the renderer fires `ok:theme:applied`.
 *   3. Resolving system/light/dark to a concrete theme. The IPC contract
 *      propagates user-intent verbatim; resolving at the call site would
 *      strip the OS-tracking semantics that 'system' carries.
 */

import type { OkThemeSource } from '../shared/bridge-contract.ts';

const VALID_THEME_SOURCES: ReadonlySet<OkThemeSource> = new Set(['system', 'light', 'dark']);

/**
 * Type predicate for `OkThemeSource`. Use at any seam where a value
 * crosses from outside our type system (Electron's `nativeTheme.themeSource`,
 * a debugger-injected IPC payload) into our domain — the canonical guard
 * shared between the read and write paths in the IPC handler.
 */
export function isOkThemeSource(value: unknown): value is OkThemeSource {
  return typeof value === 'string' && VALID_THEME_SOURCES.has(value as OkThemeSource);
}

interface ApplyThemeSourceDeps {
  /** Read current nativeTheme.themeSource for the prevSource log field. */
  getThemeSource: () => OkThemeSource;
  /** Set nativeTheme.themeSource. */
  setThemeSource: (source: OkThemeSource) => void;
  /** Diagnostic sink for structured warn lines. Production wires console.warn. */
  warn: (line: string) => void;
}

/**
 * Apply a renderer-supplied theme source. Returns `{ ok: true }` on both the
 * happy path AND on defensive rejection — a malicious or misconfigured
 * renderer can't observe whether its value was honored, only that the call
 * was acknowledged. The diagnostic surface is the structured warn log.
 *
 * The defensive branch handles:
 *   - A future bridge-contract divergence (setThemeSource accepts a 4th value
 *     at one of the three mirrors but not another).
 *   - A non-typed IPC bypass (e.g. raw `ipcRenderer.invoke` from a debugger).
 *
 * The trust-boundary classification is unambiguous: data crosses the
 * renderer→main process seam, arrives via IPC marshaling, and the read
 * happens in the imperative shell.
 */
export function applyThemeSource(deps: ApplyThemeSourceDeps, source: OkThemeSource): { ok: true } {
  if (!VALID_THEME_SOURCES.has(source)) {
    deps.warn(
      JSON.stringify({
        event: 'theme-source-set-rejected',
        received: source,
        reason: 'invalid-source',
      }),
    );
    return { ok: true };
  }

  const prevSource = deps.getThemeSource();
  deps.setThemeSource(source);
  deps.warn(
    JSON.stringify({
      event: 'theme-source-set',
      source,
      prevSource,
      trigger: 'ipc',
    }),
  );
  return { ok: true };
}
