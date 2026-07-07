/**
 * Pre-window boot orchestration. Pure-ish wrapper that owns the whenReady
 * prefix where IPC handler registration must precede `nativeTheme.themeSource`,
 * and `nativeTheme.themeSource` must precede any BrowserWindow construction
 * the caller performs.
 *
 * The 'system' source is also Electron's default, but setting it explicitly
 * creates an architectural seam that is the canonical pre-window-creation
 * hook. The cold-launch chrome
 * correctness contract (window-show gate listening for `ok:theme:applied`)
 * relies on the IPC handlers being registered BEFORE the renderer mounts,
 * which in turn relies on this ordering.
 *
 * Pure: no Electron imports, no module-level state, no I/O — every effect
 * runs through the injected `deps`. The caller (main/index.ts whenReady)
 * wires real platform APIs.
 */

import type { OkThemeSource } from '../shared/bridge-contract.ts';
import type { AppState, SchemaIncompatibilityDiagnostic } from './state-store.ts';

/** Result of a schema-version compatibility check (subset of state-store's internal type). */
type SchemaCompatibilityResult =
  | { status: 'ok' }
  | { status: 'incompatible'; diagnostic: SchemaIncompatibilityDiagnostic };

interface BootstrapDeps {
  /** Read persisted app state from userData/state.json. Returns emptyState() on miss/corrupt. */
  loadAppState: () => AppState;
  /**
   * Compare persisted state's schemaVersion against MAX_SUPPORTED. When it
   * exceeds, the running build was rolled back to from a future build —
   * surface the diagnostic instead of silently overwriting.
   */
  evaluateSchemaCompatibility: (
    state: AppState,
    maxSupported: number,
    currentBuild: string,
  ) => SchemaCompatibilityResult;
  /** Inject CORS headers on localhost responses so Vite dev assets load under contextIsolation. */
  installLocalhostCorsInjector: () => void;
  /**
   * Rewrite the outbound `Referer` on YouTube embed-iframe requests so
   * the iframe player accepts the embed when the renderer is loaded
   * via `file://` in packaged builds (the root cause of "Error 153:
   * Video player configuration error" on packaged-DMG installs).
   * See `embed-referer.ts` for the full rationale.
   */
  installEmbedRefererRewriter: () => void;
  /**
   * Bind every typed IPC handler. MUST run before setNativeThemeSource so the
   * renderer's `ok:theme:set-source` / `ok:theme:applied` channels are
   * reachable when the renderer mounts.
   */
  registerIpcHandlers: () => void;
  /**
   * Set Electron's nativeTheme.themeSource. The 'system' default is also
   * Electron's default, but pinning it here gives us an explicit
   * architectural seam.
   */
  setNativeThemeSource: (source: OkThemeSource) => void;
  /** Re-install the application menu — the auto-updater handle hooks in here later. */
  refreshApplicationMenu: () => void;
  /** Set the macOS Dock icon if the bundle ships a packaged-mode override. */
  installDockIcon: () => void;
  /** Diagnostic sink for the schemaVersion-incompatible branch. */
  log: { warn: (msg: string, obj?: unknown) => void };
  /** `app.getVersion()` at boot time. */
  appVersion: string;
  /** `MAX_SUPPORTED_SCHEMA_VERSION` from state-store. */
  maxSupportedSchemaVersion: number;
}

interface BootstrapResult {
  /** State the caller writes into the module-level appState binding. */
  appState: AppState;
  /**
   * Schema-incompatibility diagnostic if the persisted state was written by
   * a future build, else null. Renderer surfaces (refuse-downgrade Toast)
   * read it on mount.
   */
  pendingSchemaIncompatibility: SchemaIncompatibilityDiagnostic | null;
}

export async function runBootstrap(deps: BootstrapDeps): Promise<BootstrapResult> {
  const appState = deps.loadAppState();

  let pendingSchemaIncompatibility: SchemaIncompatibilityDiagnostic | null = null;
  const compat = deps.evaluateSchemaCompatibility(
    appState,
    deps.maxSupportedSchemaVersion,
    deps.appVersion,
  );
  if (compat.status === 'incompatible') {
    pendingSchemaIncompatibility = compat.diagnostic;
    deps.log.warn('[main] schemaVersion incompatibility detected', compat.diagnostic);
  }

  deps.installLocalhostCorsInjector();
  deps.installEmbedRefererRewriter();

  // IPC handlers MUST register before the nativeTheme.themeSource set so the
  // window-show gate's `ok:theme:applied` channel is reachable when the
  // renderer mounts (the renderer fires the event after ConfigProvider's
  // first sync; if the channel is dead, the show-gate stalls until the 5 s
  // timeout fallback).
  deps.registerIpcHandlers();

  // nativeTheme.themeSource MUST be set before the caller creates any
  // BrowserWindow. Electron's default is also 'system' — we set it here for
  // the architectural seam.
  deps.setNativeThemeSource('system');

  deps.refreshApplicationMenu();
  deps.installDockIcon();

  return { appState, pendingSchemaIncompatibility };
}
