/**
 * Pre-project local-op IPC handlers — GitHub device-flow auth + git clone.
 *
 * The Navigator window has no backing API server (apiOrigin is empty —
 * see `packages/desktop/src/main/navigator-window.ts`), so the renderer's
 * `fetch('/api/local-op/...')` calls hit electron-vite's renderer dev
 * server and 404. These IPC handlers spawn the same CLI subprocess that
 * the HTTP relay would have, streaming events back to the renderer via
 * `webContents.send`.
 *
 * Editor windows continue to use the HTTP path — there's no regression
 * because the IPC handlers are gated to renderer-driven IPC invocations
 * only (the HTTP handler in `api-extension.ts` is untouched).
 *
 * Subprocess shape comes from `@inkeep/open-knowledge-server`'s
 * `local-ops` module — the same runners power both the HTTP and IPC
 * paths so they can't drift.
 */

import { randomUUID } from 'node:crypto';
import {
  type AuthReposResponse,
  type AuthStatusResponse,
  type RunCloneController,
  type RunDeviceFlowController,
  runAuthReposSubprocess,
  runAuthStatusSubprocess,
  runCloneSubprocess,
  runDeviceFlowSubprocess,
  validateCloneInputs,
} from '@inkeep/open-knowledge-server';
import type { SendableWebContents } from '../../shared/ipc-send.ts';
import { sendToRenderer } from '../../shared/ipc-send.ts';

/** Single in-flight flow per channel. A second `:start` before `:cancel`
 *  atomically cancels the stale subprocess and claims a fresh slot. */
interface InFlightAuth {
  streamId: string;
  controller: RunDeviceFlowController;
}
interface InFlightClone {
  streamId: string;
  controller: RunCloneController;
}

/**
 * Cap on concurrent one-shot auth queries (`status` + `repos`) across distinct
 * hosts. The renderer is sandboxed but a compromised renderer (or a runaway
 * effect loop) can spam these channels — each one spawns a CLI subprocess
 * with up to a 30 s wall-clock timeout. Without a bound, a tight invoke loop
 * exhausts file descriptors / PIDs / memory faster than the subprocesses
 * complete.
 *
 * Coalescing per host (below) collapses repeated calls for the same host
 * onto one subprocess; this cap defends against fan-out via a varying
 * `host` argument. The bound is per handler-type (`status` / `repos`),
 * not shared, so the worst-case concurrent subprocess budget across both
 * handlers is `2 * MAX_CONCURRENT_AUTH_QUERIES`. 4 is generously above
 * the realistic ceiling (one host — `github.com` — is the only consumer
 * today) while keeping any future legitimate multi-host UI from regressing.
 */
const MAX_CONCURRENT_AUTH_QUERIES = 4;

interface LocalOpHandlerState {
  authInFlight: InFlightAuth | null;
  cloneInFlight: InFlightClone | null;
  /** Coalesced in-flight `auth status` queries keyed by host. */
  authStatusInFlight: Map<string, Promise<AuthStatusResponse>>;
  /** Coalesced in-flight `auth repos` queries keyed by host. */
  authReposInFlight: Map<string, Promise<AuthReposResponse>>;
}

export function createLocalOpState(): LocalOpHandlerState {
  return {
    authInFlight: null,
    cloneInFlight: null,
    authStatusInFlight: new Map(),
    authReposInFlight: new Map(),
  };
}

export interface LocalOpDeps {
  /**
   * Resolve the CLI argv prefix (e.g. `[wrapperPath]` or
   * `[process.execPath, scriptPath]`). Returned at call time so packaged
   * vs dev mode can differ. The dev-mode prefix invokes the workspace's
   * `cli` package via `bun ...` — the packaged prefix invokes the
   * bundled `<bundle>/Contents/Resources/cli/bin/ok.sh` wrapper.
   */
  resolveCliArgs: () => readonly string[];
  /**
   * `webContents.send` target. Always the BrowserWindow that invoked the
   * `:start` channel — captured at the time of the invoke so a window
   * close mid-flow doesn't crash the dispatch (`isDestroyed` is checked
   * before each send).
   */
  state: LocalOpHandlerState;
}

/**
 * Handler for `ok:local-op:auth:start`. Spawns the device-flow subprocess
 * and pipes events back to the caller. Returns a fresh `streamId`.
 */
export function handleAuthStart(
  deps: LocalOpDeps,
  sender: SendableWebContents,
): { ok: true; streamId: string } | { ok: false; error: string } {
  const streamId = randomUUID();
  // Renderer-side cleanup IPC is best-effort; on a missed `:cancel` the slot
  // would otherwise pin until the CLI's internal device-flow timeout.
  // Synchronously displace the stale slot here so the next start claims a
  // fresh subprocess. The displacement is logged at `warn` (not `info`)
  // because it signals that the renderer-side cancel chain failed — ops
  // can grep for the event to detect renderer-cleanup regressions before
  // they surface to users.
  const stale = deps.state.authInFlight;
  if (stale) {
    stale.controller.cancel();
    deps.state.authInFlight = null;
    console.warn(
      JSON.stringify({
        event: 'ok-local-op:idempotent-start-replaced-stale-slot',
        channel: 'auth',
        staleStreamId: stale.streamId,
        newStreamId: streamId,
      }),
    );
  }
  const controller = runDeviceFlowSubprocess({
    cliArgs: deps.resolveCliArgs(),
    onEvent: (event) => {
      // The wrapper guards against sending to a destroyed webContents —
      // window-close mid-flow would otherwise crash the main process.
      if (!sender.isDestroyed?.()) {
        sendToRenderer(sender, 'ok:local-op:auth:event', { streamId, event });
      }
    },
  });
  deps.state.authInFlight = { streamId, controller };
  void controller.done.finally(() => {
    if (deps.state.authInFlight?.streamId === streamId) {
      deps.state.authInFlight = null;
    }
  });
  return { ok: true, streamId };
}

/** Handler for `ok:local-op:auth:cancel`. */
export function handleAuthCancel(deps: LocalOpDeps, streamId: string): void {
  if (deps.state.authInFlight && deps.state.authInFlight.streamId === streamId) {
    deps.state.authInFlight.controller.cancel();
    // Clear the slot synchronously so a back-to-back start doesn't trip
    // the busy guard during the SIGTERM-to-exit window (~50–100ms). The
    // `controller.done.finally` hook will fire later but no-ops because
    // it streamId-checks against the (now-different or null) slot.
    deps.state.authInFlight = null;
  }
}

/** Handler for `ok:local-op:clone:start`. */
export function handleCloneStart(
  deps: LocalOpDeps,
  sender: SendableWebContents,
  request: { url: string; dir: string; branch?: string | null },
): { ok: true; streamId: string } | { ok: false; error: string } {
  const validation = validateCloneInputs(request.url, request.dir);
  if (!validation.ok) {
    return {
      ok: false,
      error:
        validation.reason === 'invalid-url'
          ? 'URL protocol not allowed'
          : 'dir must be within the user home directory',
    };
  }
  const streamId = randomUUID();
  // Renderer-side cleanup IPC is best-effort; on a missed `:cancel` the slot
  // would otherwise pin until the CLI subprocess's wall-clock timeout.
  // Synchronously displace the stale slot here so the next start claims a
  // fresh subprocess. Validate first so an invalid request doesn't kill an
  // in-flight stale clone that the user might still recover. The
  // displacement is logged at `warn` (not `info`) because it signals that
  // the renderer-side cancel chain failed — ops can grep for the event to
  // detect renderer-cleanup regressions before they surface to users.
  const stale = deps.state.cloneInFlight;
  if (stale) {
    stale.controller.cancel();
    deps.state.cloneInFlight = null;
    console.warn(
      JSON.stringify({
        event: 'ok-local-op:idempotent-start-replaced-stale-slot',
        channel: 'clone',
        staleStreamId: stale.streamId,
        newStreamId: streamId,
      }),
    );
  }
  const controller = runCloneSubprocess({
    cliArgs: deps.resolveCliArgs(),
    url: request.url,
    dir: request.dir,
    branch: request.branch,
    onEvent: (event) => {
      if (sender.isDestroyed?.()) return;
      sendToRenderer(sender, 'ok:local-op:clone:event', { streamId, event });
    },
  });
  deps.state.cloneInFlight = { streamId, controller };
  void controller.done.finally(() => {
    if (deps.state.cloneInFlight?.streamId === streamId) {
      deps.state.cloneInFlight = null;
    }
  });
  return { ok: true, streamId };
}

/** Handler for `ok:local-op:clone:cancel`. */
export function handleCloneCancel(deps: LocalOpDeps, streamId: string): void {
  if (deps.state.cloneInFlight && deps.state.cloneInFlight.streamId === streamId) {
    deps.state.cloneInFlight.controller.cancel();
    // Clear synchronously — see auth-cancel for rationale.
    deps.state.cloneInFlight = null;
  }
}

/** Default host argument shared with the CLI runners — kept in sync so the
 *  cache key matches the runner's resolved host even when the caller omits
 *  the field. */
const DEFAULT_AUTH_QUERY_HOST = 'github.com';

/**
 * Run a one-shot auth-query subprocess with two safeguards:
 *
 *   1. Coalesce by host — concurrent calls for the same host reuse the
 *      already-in-flight Promise instead of spawning a duplicate subprocess.
 *   2. Cap total distinct in-flight hosts at `MAX_CONCURRENT_AUTH_QUERIES`.
 *
 * Together these bound the subprocess fan-out a renderer can drive: a
 * tight `bridge.localOp.authStatus()` loop coalesces onto one subprocess;
 * a renderer that varies `host` to defeat the cache caps out at the limit
 * and gets `tooManyError(host)` for the overflow.
 */
function runCoalescedAuthQuery<T>(
  inFlight: Map<string, Promise<T>>,
  host: string,
  spawn: () => Promise<T>,
  tooManyError: (host: string) => T,
): Promise<T> {
  const existing = inFlight.get(host);
  if (existing) return existing;
  if (inFlight.size >= MAX_CONCURRENT_AUTH_QUERIES) {
    return Promise.resolve(tooManyError(host));
  }
  const promise = spawn().finally(() => {
    inFlight.delete(host);
  });
  inFlight.set(host, promise);
  return promise;
}

/**
 * Handler for `ok:local-op:auth:status`. One-shot — spawns the CLI, waits
 * for completion, returns the parsed status response. No streaming surface
 * because the CLI emits a single line then exits.
 *
 * Renderer-driven invocations are coalesced + capped (see
 * `runCoalescedAuthQuery`) so a compromised renderer can't flood the main
 * process with concurrent CLI subprocesses.
 */
export function handleAuthStatus(
  deps: LocalOpDeps,
  request?: { host?: string },
): Promise<AuthStatusResponse> {
  const host = request?.host ?? DEFAULT_AUTH_QUERY_HOST;
  return runCoalescedAuthQuery(
    deps.state.authStatusInFlight,
    host,
    () =>
      runAuthStatusSubprocess({
        cliArgs: deps.resolveCliArgs(),
        host: request?.host,
      }),
    (h) => ({
      authenticated: false,
      host: h,
      error: 'too many concurrent auth status queries',
    }),
  );
}

/**
 * Handler for `ok:local-op:auth:repos`. One-shot — spawns the CLI, waits
 * for the bounded repo list, returns it. Coalesced + capped — see
 * `handleAuthStatus` for the rationale.
 */
export function handleAuthRepos(
  deps: LocalOpDeps,
  request?: { host?: string },
): Promise<AuthReposResponse> {
  const host = request?.host ?? DEFAULT_AUTH_QUERY_HOST;
  return runCoalescedAuthQuery(
    deps.state.authReposInFlight,
    host,
    () =>
      runAuthReposSubprocess({
        cliArgs: deps.resolveCliArgs(),
        host: request?.host,
      }),
    () => ({
      ok: false,
      error: 'too many concurrent auth repos queries',
    }),
  );
}
