import type {
  AuthEvent,
  AuthReposResponse,
  AuthStatusResponse,
  CloneEvent,
} from '@inkeep/open-knowledge-server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

interface StreamEntry<E> {
  resolve: () => void;
  onEvent: (event: E) => void;
}

const deviceFlowControllers: StreamEntry<AuthEvent>[] = [];
const cloneControllers: StreamEntry<CloneEvent>[] = [];

let statusResponse: AuthStatusResponse = { authenticated: false, host: 'github.com' };
let reposResponse: AuthReposResponse = { ok: true, host: 'github.com', repos: [] };

function pushController<E>(
  registry: StreamEntry<E>[],
  onEvent: (event: E) => void,
): { done: Promise<void>; cancel: () => void } {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  registry.push({ resolve: resolveDone, onEvent });
  return { done, cancel: () => {} };
}

vi.doMock('@inkeep/open-knowledge-server', () => ({
  runAuthStatusSubprocess: () => Promise.resolve(statusResponse),
  runAuthReposSubprocess: () => Promise.resolve(reposResponse),
  runDeviceFlowSubprocess: ({ onEvent }: { onEvent: (event: AuthEvent) => void }) =>
    pushController(deviceFlowControllers, onEvent),
  runCloneSubprocess: ({ onEvent }: { onEvent: (event: CloneEvent) => void }) =>
    pushController(cloneControllers, onEvent),
  validateCloneInputs: () => ({ ok: true }),
}));

const {
  createLocalOpState,
  handleAuthCancel,
  handleAuthRepos,
  handleAuthStart,
  handleAuthStatus,
  handleCloneCancel,
  handleCloneStart,
} = await import('./local-op.ts');

function makeSender() {
  return {
    isDestroyed: () => false,
    send: () => {},
  };
}

function makeDeps() {
  return {
    resolveCliInvocation: () => ({ cliArgs: ['open-knowledge'] }),
    logFailure: vi.fn(),
    state: createLocalOpState(),
  };
}

const CLONE_REQ = { url: 'https://example.test/r.git', dir: '/tmp/r' };

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  deviceFlowControllers.length = 0;
  cloneControllers.length = 0;
  statusResponse = { authenticated: false, host: 'github.com' };
  reposResponse = { ok: true, host: 'github.com', repos: [] };
});

describe('handleAuthStart — terminal failure reaches the desktop log', () => {
  test('a terminal error event logs the spawn failure once the run settles', async () => {
    const deps = makeDeps();
    const result = handleAuthStart(deps, makeSender());
    expect(result.ok).toBe(true);

    deviceFlowControllers[0]?.onEvent({
      type: 'error',
      message: 'auth login exited with code -1 — spawn EINVAL',
    });
    expect(deps.logFailure).not.toHaveBeenCalled();

    deviceFlowControllers[0]?.resolve();
    await settle();

    expect(deps.logFailure).toHaveBeenCalledTimes(1);
    expect(deps.logFailure).toHaveBeenCalledWith({
      event: 'ipc.error',
      channel: 'ok:local-op:auth:start',
      reason: 'auth login exited with code -1 — spawn EINVAL',
      handler: 'handleAuthStart',
    });
  });

  test('cancelling a sign-in that emitted no error clears the in-flight slot and logs nothing', async () => {
    const deps = makeDeps();
    const result = handleAuthStart(deps, makeSender());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.state.authInFlight).not.toBeNull();

    handleAuthCancel(deps, result.streamId);
    expect(deps.state.authInFlight).toBeNull();

    deviceFlowControllers[0]?.resolve();
    await settle();

    expect(deps.logFailure).not.toHaveBeenCalled();
  });

  test('a sign-in that emitted a terminal error before the user cancelled still logs it once', async () => {
    const deps = makeDeps();
    const result = handleAuthStart(deps, makeSender());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    deviceFlowControllers[0]?.onEvent({
      type: 'error',
      message: 'auth login exited with code -1 — spawn EINVAL',
    });
    handleAuthCancel(deps, result.streamId);
    deviceFlowControllers[0]?.resolve();
    await settle();

    expect(deps.logFailure).toHaveBeenCalledTimes(1);
    expect(deps.logFailure).toHaveBeenCalledWith({
      event: 'ipc.error',
      channel: 'ok:local-op:auth:start',
      reason: 'auth login exited with code -1 — spawn EINVAL',
      handler: 'handleAuthStart',
    });
  });

  test('a successful sign-in logs nothing', async () => {
    const deps = makeDeps();
    handleAuthStart(deps, makeSender());

    deviceFlowControllers[0]?.onEvent({
      type: 'verification',
      user_code: 'ABCD',
      verification_uri: 'https://example.test/login',
      expires_in: 60,
    });
    deviceFlowControllers[0]?.onEvent({ type: 'complete', host: 'github.com', login: 'octocat' });
    deviceFlowControllers[0]?.resolve();
    await settle();

    expect(deps.logFailure).not.toHaveBeenCalled();
  });
});

describe('handleCloneStart — terminal failure reaches the desktop log', () => {
  test('a terminal error event logs the clone failure once the run settles', async () => {
    const deps = makeDeps();
    const result = handleCloneStart(deps, makeSender(), CLONE_REQ);
    expect(result.ok).toBe(true);

    cloneControllers[0]?.onEvent({
      type: 'error',
      message: 'Clone process exited with code -1 — spawn EINVAL',
    });
    cloneControllers[0]?.resolve();
    await settle();

    expect(deps.logFailure).toHaveBeenCalledTimes(1);
    expect(deps.logFailure).toHaveBeenCalledWith({
      event: 'ipc.error',
      channel: 'ok:local-op:clone:start',
      reason: 'Clone process exited with code -1 — spawn EINVAL',
      handler: 'handleCloneStart',
    });
  });

  test('cancelling a clone that emitted no error clears the in-flight slot and logs nothing', async () => {
    const deps = makeDeps();
    const result = handleCloneStart(deps, makeSender(), CLONE_REQ);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.state.cloneInFlight).not.toBeNull();

    handleCloneCancel(deps, result.streamId);
    expect(deps.state.cloneInFlight).toBeNull();

    cloneControllers[0]?.onEvent({ type: 'progress', phase: 'receiving', pct: 12 });
    cloneControllers[0]?.resolve();
    await settle();

    expect(deps.logFailure).not.toHaveBeenCalled();
  });

  test('a clone that emitted a terminal error before the user cancelled still logs it once', async () => {
    const deps = makeDeps();
    const result = handleCloneStart(deps, makeSender(), CLONE_REQ);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    cloneControllers[0]?.onEvent({
      type: 'error',
      message: 'Clone process exited with code -1 — spawn EINVAL',
    });
    handleCloneCancel(deps, result.streamId);
    cloneControllers[0]?.resolve();
    await settle();

    expect(deps.logFailure).toHaveBeenCalledTimes(1);
    expect(deps.logFailure).toHaveBeenCalledWith({
      event: 'ipc.error',
      channel: 'ok:local-op:clone:start',
      reason: 'Clone process exited with code -1 — spawn EINVAL',
      handler: 'handleCloneStart',
    });
  });

  test('a successful clone logs nothing', async () => {
    const deps = makeDeps();
    handleCloneStart(deps, makeSender(), CLONE_REQ);

    cloneControllers[0]?.onEvent({ type: 'progress', phase: 'receiving', pct: 50 });
    cloneControllers[0]?.onEvent({ type: 'complete', port: 0, dir: '/tmp/r' });
    cloneControllers[0]?.resolve();
    await settle();

    expect(deps.logFailure).not.toHaveBeenCalled();
  });
});

describe('handleAuthStatus / handleAuthRepos — query failures reach the desktop log', () => {
  test('an unauthenticated status carrying no error does not log (benign poll)', async () => {
    statusResponse = { authenticated: false, host: 'github.com' };
    const deps = makeDeps();
    await handleAuthStatus(deps, { host: 'github.com' });
    expect(deps.logFailure).not.toHaveBeenCalled();
  });

  test('an authenticated status does not log', async () => {
    statusResponse = { authenticated: true, host: 'github.com', login: 'octocat' };
    const deps = makeDeps();
    await handleAuthStatus(deps, { host: 'github.com' });
    expect(deps.logFailure).not.toHaveBeenCalled();
  });

  test('a status carrying the subprocess stderr logs it', async () => {
    statusResponse = { authenticated: false, host: 'github.com', error: 'spawn EINVAL' };
    const deps = makeDeps();
    await handleAuthStatus(deps, { host: 'github.com' });
    expect(deps.logFailure).toHaveBeenCalledTimes(1);
    expect(deps.logFailure).toHaveBeenCalledWith({
      event: 'ipc.error',
      channel: 'ok:local-op:auth:status',
      reason: 'spawn EINVAL',
      handler: 'handleAuthStatus',
    });
  });

  test('two coalesced status callers produce a single log line', async () => {
    statusResponse = { authenticated: false, host: 'github.com', error: 'spawn EINVAL' };
    const deps = makeDeps();
    await Promise.all([
      handleAuthStatus(deps, { host: 'github.com' }),
      handleAuthStatus(deps, { host: 'github.com' }),
    ]);
    expect(deps.logFailure).toHaveBeenCalledTimes(1);
  });

  test('a successful repos listing does not log', async () => {
    reposResponse = { ok: true, host: 'github.com', repos: [] };
    const deps = makeDeps();
    await handleAuthRepos(deps, { host: 'github.com' });
    expect(deps.logFailure).not.toHaveBeenCalled();
  });

  test('a signed-out repos response does not log (first-run state, not a failure)', async () => {
    reposResponse = {
      ok: false,
      error: '[auth] token storage: OS keychain\nNot logged in to github.com',
      authenticated: false,
    };
    const deps = makeDeps();
    await handleAuthRepos(deps, { host: 'github.com' });
    expect(deps.logFailure).not.toHaveBeenCalled();
  });

  test('a failed repos listing logs the subprocess error', async () => {
    reposResponse = { ok: false, error: 'auth repos exited with code -1' };
    const deps = makeDeps();
    await handleAuthRepos(deps, { host: 'github.com' });
    expect(deps.logFailure).toHaveBeenCalledTimes(1);
    expect(deps.logFailure).toHaveBeenCalledWith({
      event: 'ipc.error',
      channel: 'ok:local-op:auth:repos',
      reason: 'auth repos exited with code -1',
      handler: 'handleAuthRepos',
    });
  });
});
