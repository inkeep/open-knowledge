/**
 * Pure, dependency-injected IPC handler implementations for the schema-
 * incompatibility surface (`ok:state:reset-incompatible`, `ok:state:query`).
 *
 * Same pattern as `ipc-handlers.ts` (Open-in-Agent / Cursor / handoff): the
 * handler functions take an explicit `deps` object so they can run under
 * `bun test` without an Electron `app` module. `main/index.ts` is the only
 * file that touches raw `appState` / Electron IPC primitives — extraction
 * here lets the unit tier pin the composition including the rollback path
 * that fires when `saveAppState` returns false.
 *
 * The update channel has no `set-channel` handler — channels are install-
 * time-sticky and derived solely from the running build's version string
 * via `channelFromVersion` in `auto-updater.ts`. The `ok:state:query`
 * snapshot reports that build-derived channel via the `getBuildChannel` dep.
 */
import {
  type AppState,
  emptyState,
  type SchemaIncompatibilityDiagnostic,
  type UpdateChannel,
} from './state-store.ts';

export interface UpdateStateHandlerDeps {
  /** Read the current in-memory `appState` snapshot. */
  getAppState: () => AppState;
  /** Replace the in-memory `appState`. Tests use this to observe rollback. */
  setAppState: (next: AppState) => void;
  /**
   * Persist `appState` to disk. Returns `false` on disk failure (EACCES, disk
   * full, etc.) so callers can roll back the in-memory mutation. Mirrors
   * `saveAppState` in `main/index.ts`.
   */
  saveAppState: (next: AppState) => boolean;
  /**
   * The auto-update channel derived from the running build's version string
   * (`channelFromVersion(app.getVersion())`). Surfaced to renderers via
   * `ok:state:query` so the BETA badge / About-panel label reflect the
   * installed binary.
   */
  getBuildChannel: () => UpdateChannel;
  /** Read the boot-time schema-incompatibility diagnostic, or `null`. */
  getPendingSchemaIncompatibility: () => SchemaIncompatibilityDiagnostic | null;
  /** Drop the pending diagnostic so subsequent queries return `null`. */
  clearPendingSchemaIncompatibility: () => void;
}

/**
 * Result shape for `ok:state:query`. Mirrors the IPC channel result from
 * `shared/ipc-channels.ts` — kept inline rather than imported so this
 * module is decoupled from the renderer-facing IPC types.
 */
interface StateQueryResult {
  channel: UpdateChannel;
  schemaIncompatibility: SchemaIncompatibilityDiagnostic | null;
}

/**
 * `ok:state:reset-incompatible` handler. Wipes `appState` to defaults so a
 * future-build state shape can't be partially-trusted (we don't know which
 * fields were reshaped — full reset is the only mechanically-safe choice),
 * then persists with rollback and clears the pending diagnostic. The live
 * updater session's channel is build-derived and unaffected by this reset.
 */
export async function applyResetIncompatible(deps: UpdateStateHandlerDeps): Promise<undefined> {
  const prev = deps.getAppState();
  const fresh = emptyState();
  deps.setAppState(fresh);
  if (!deps.saveAppState(fresh)) {
    deps.setAppState(prev);
    throw new Error('saveAppState failed — incompatibility reset not persisted');
  }
  deps.clearPendingSchemaIncompatibility();
  return undefined;
}

/**
 * `ok:state:query` handler. Returns a snapshot of the build-derived channel
 * + any pending refuse-downgrade diagnostic for newly-opened windows that
 * missed the boot-time surface.
 */
export async function applyStateQuery(deps: UpdateStateHandlerDeps): Promise<StateQueryResult> {
  const compat = deps.getPendingSchemaIncompatibility();
  return {
    channel: deps.getBuildChannel(),
    schemaIncompatibility: compat ? { ...compat } : null,
  };
}
