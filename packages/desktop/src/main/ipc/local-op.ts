import { randomUUID } from 'node:crypto';
import {
  type AuthReposResponse,
  type AuthStatusResponse,
  type LocalOpCliInvocation,
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

interface LocalOpFailure {
  readonly event: 'ipc.error';
  readonly channel: string;
  readonly reason: string;
  readonly handler: string;
}

export interface LocalOpDeps {
  resolveCliInvocation: () => LocalOpCliInvocation;
  logFailure: (failure: LocalOpFailure) => void;
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
  let terminalError: string | null = null;
  const controller = runDeviceFlowSubprocess({
    ...deps.resolveCliInvocation(),
    onEvent: (event) => {
      if (event.type === 'error') terminalError = event.message;
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
    if (terminalError !== null) {
      deps.logFailure({
        event: 'ipc.error',
        channel: 'ok:local-op:auth:start',
        reason: terminalError,
        handler: 'handleAuthStart',
      });
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
  let terminalError: string | null = null;
  const controller = runCloneSubprocess({
    ...deps.resolveCliInvocation(),
    url: request.url,
    dir: request.dir,
    branch: request.branch,
    onEvent: (event) => {
      if (event.type === 'error') terminalError = event.message;
      if (sender.isDestroyed?.()) return;
      sendToRenderer(sender, 'ok:local-op:clone:event', { streamId, event });
    },
  });
  deps.state.cloneInFlight = { streamId, controller };
  void controller.done.finally(() => {
    if (deps.state.cloneInFlight?.streamId === streamId) {
      deps.state.cloneInFlight = null;
    }
    if (terminalError !== null) {
      deps.logFailure({
        event: 'ipc.error',
        channel: 'ok:local-op:clone:start',
        reason: terminalError,
        handler: 'handleCloneStart',
      });
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

/*
 * WARN: shared with the CLI runners' default host. Drift silently misses the
 * cache when the caller omits the field rather than failing.
 */
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
  // oxlint-disable-next-line ok/require-windowshide-on-spawn -- callback starts a request; it is not node:child_process.spawn
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
  const logged = (response: AuthStatusResponse): AuthStatusResponse => {
    if (!response.authenticated && response.error !== undefined) {
      deps.logFailure({
        event: 'ipc.error',
        channel: 'ok:local-op:auth:status',
        reason: response.error,
        handler: 'handleAuthStatus',
      });
    }
    return response;
  };
  return runCoalescedAuthQuery(
    deps.state.authStatusInFlight,
    host,
    () =>
      runAuthStatusSubprocess({
        ...deps.resolveCliInvocation(),
        host: request?.host,
      }).then(logged),
    (h) =>
      logged({
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
  const logged = (response: AuthReposResponse): AuthReposResponse => {
    if (!response.ok && response.authenticated !== false) {
      deps.logFailure({
        event: 'ipc.error',
        channel: 'ok:local-op:auth:repos',
        reason: response.error,
        handler: 'handleAuthRepos',
      });
    }
    return response;
  };
  return runCoalescedAuthQuery(
    deps.state.authReposInFlight,
    host,
    () =>
      runAuthReposSubprocess({
        ...deps.resolveCliInvocation(),
        host: request?.host,
      }).then(logged),
    () =>
      logged({
        ok: false,
        error: 'too many concurrent auth repos queries',
      }),
  );
}
