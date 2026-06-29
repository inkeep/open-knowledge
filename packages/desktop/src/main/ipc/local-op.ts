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

const MAX_CONCURRENT_AUTH_QUERIES = 4;

interface LocalOpHandlerState {
  authInFlight: InFlightAuth | null;
  cloneInFlight: InFlightClone | null;
  authStatusInFlight: Map<string, Promise<AuthStatusResponse>>;
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
  resolveCliArgs: () => readonly string[];
  state: LocalOpHandlerState;
}

export function handleAuthStart(
  deps: LocalOpDeps,
  sender: SendableWebContents,
): { ok: true; streamId: string } | { ok: false; error: string } {
  const streamId = randomUUID();
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

export function handleAuthCancel(deps: LocalOpDeps, streamId: string): void {
  if (deps.state.authInFlight && deps.state.authInFlight.streamId === streamId) {
    deps.state.authInFlight.controller.cancel();
    deps.state.authInFlight = null;
  }
}

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

export function handleCloneCancel(deps: LocalOpDeps, streamId: string): void {
  if (deps.state.cloneInFlight && deps.state.cloneInFlight.streamId === streamId) {
    deps.state.cloneInFlight.controller.cancel();
    deps.state.cloneInFlight = null;
  }
}

/** Default host argument shared with the CLI runners — kept in sync so the
 *  cache key matches the runner's resolved host even when the caller omits
 *  the field. */
const DEFAULT_AUTH_QUERY_HOST = 'github.com';

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
