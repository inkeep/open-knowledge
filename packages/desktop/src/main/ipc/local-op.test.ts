/**
 * Coverage for the auth-query coalescing + concurrency cap added to
 * `handleAuthStatus` / `handleAuthRepos`. Without these guards a
 * sandboxed-but-compromised renderer can flood `ok:local-op:auth:{status,repos}`
 * to spawn an unbounded number of CLI subprocesses (each with up to a 30 s
 * wall-clock timeout), exhausting file descriptors / PIDs / memory.
 *
 * The handlers route subprocess spawns through `runAuthStatusSubprocess` /
 * `runAuthReposSubprocess` from `@inkeep/open-knowledge-server`, which we
 * mock at the module boundary so these tests never touch the real CLI. The
 * factories surface a `resolve` hook so the test can hold each "subprocess"
 * mid-flight while it asserts coalescing behavior.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { AuthReposResponse, AuthStatusResponse } from '@inkeep/open-knowledge-server';

const statusCalls: Array<{ host: string | undefined; resolve: (r: AuthStatusResponse) => void }> =
  [];
const reposCalls: Array<{ host: string | undefined; resolve: (r: AuthReposResponse) => void }> = [];

mock.module('@inkeep/open-knowledge-server', () => ({
  runAuthStatusSubprocess: ({ host }: { host?: string }) =>
    new Promise<AuthStatusResponse>((resolve) => {
      statusCalls.push({ host, resolve });
    }),
  runAuthReposSubprocess: ({ host }: { host?: string }) =>
    new Promise<AuthReposResponse>((resolve) => {
      reposCalls.push({ host, resolve });
    }),
  // Unused by status/repos handlers but imported by the module.
  runCloneSubprocess: () => ({ done: Promise.resolve(), cancel: () => {} }),
  runDeviceFlowSubprocess: () => ({ done: Promise.resolve(), cancel: () => {} }),
  validateCloneInputs: () => ({ ok: true }),
}));

const { createLocalOpState, handleAuthRepos, handleAuthStatus } = await import('./local-op.ts');

function makeDeps() {
  return {
    resolveCliArgs: () => ['open-knowledge'],
    state: createLocalOpState(),
  };
}

describe('handleAuthStatus — coalescing + concurrency cap', () => {
  test('two concurrent calls for the same host share one subprocess', async () => {
    statusCalls.length = 0;
    const deps = makeDeps();
    const a = handleAuthStatus(deps, { host: 'github.com' });
    const b = handleAuthStatus(deps, { host: 'github.com' });
    expect(statusCalls).toHaveLength(1);
    statusCalls[0]?.resolve({ authenticated: true, host: 'github.com', login: 'octocat' });
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toEqual(resB);
    expect(deps.state.authStatusInFlight.size).toBe(0);
  });

  test('omitted host coalesces with explicit default host (cache-key parity)', async () => {
    statusCalls.length = 0;
    const deps = makeDeps();
    const a = handleAuthStatus(deps);
    const b = handleAuthStatus(deps, { host: 'github.com' });
    expect(statusCalls).toHaveLength(1);
    statusCalls[0]?.resolve({ authenticated: false, host: 'github.com' });
    await Promise.all([a, b]);
  });

  test('cap rejects overflow with structured error and never spawns the subprocess', async () => {
    statusCalls.length = 0;
    const deps = makeDeps();
    const inFlight = [
      handleAuthStatus(deps, { host: 'h1' }),
      handleAuthStatus(deps, { host: 'h2' }),
      handleAuthStatus(deps, { host: 'h3' }),
      handleAuthStatus(deps, { host: 'h4' }),
    ];
    expect(statusCalls).toHaveLength(4);

    // 5th distinct host hits the cap synchronously — no subprocess spawned.
    const overflow = await handleAuthStatus(deps, { host: 'h5' });
    expect(statusCalls).toHaveLength(4);
    expect(overflow).toEqual({
      authenticated: false,
      host: 'h5',
      error: 'too many concurrent auth status queries',
    });

    // Drain the four in-flight queries so the cache empties before next test.
    for (const call of statusCalls) {
      call.resolve({ authenticated: false, host: call.host ?? 'github.com' });
    }
    await Promise.all(inFlight);
    expect(deps.state.authStatusInFlight.size).toBe(0);
  });

  test('completed subprocess clears its slot — sequential calls re-spawn', async () => {
    statusCalls.length = 0;
    const deps = makeDeps();
    const first = handleAuthStatus(deps, { host: 'github.com' });
    statusCalls[0]?.resolve({ authenticated: true, host: 'github.com', login: 'a' });
    await first;
    expect(deps.state.authStatusInFlight.size).toBe(0);

    const second = handleAuthStatus(deps, { host: 'github.com' });
    expect(statusCalls).toHaveLength(2);
    statusCalls[1]?.resolve({ authenticated: true, host: 'github.com', login: 'b' });
    await second;
  });
});

describe('handleAuthRepos — coalescing + concurrency cap', () => {
  test('two concurrent calls for the same host share one subprocess', async () => {
    reposCalls.length = 0;
    const deps = makeDeps();
    const a = handleAuthRepos(deps, { host: 'github.com' });
    const b = handleAuthRepos(deps, { host: 'github.com' });
    expect(reposCalls).toHaveLength(1);
    reposCalls[0]?.resolve({ ok: true, host: 'github.com', repos: [] });
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toEqual(resB);
    expect(deps.state.authReposInFlight.size).toBe(0);
  });

  test('cap rejects overflow with structured error and never spawns the subprocess', async () => {
    reposCalls.length = 0;
    const deps = makeDeps();
    const inFlight = [
      handleAuthRepos(deps, { host: 'h1' }),
      handleAuthRepos(deps, { host: 'h2' }),
      handleAuthRepos(deps, { host: 'h3' }),
      handleAuthRepos(deps, { host: 'h4' }),
    ];
    expect(reposCalls).toHaveLength(4);

    const overflow = await handleAuthRepos(deps, { host: 'h5' });
    expect(reposCalls).toHaveLength(4);
    expect(overflow).toEqual({
      ok: false,
      error: 'too many concurrent auth repos queries',
    });

    for (const call of reposCalls) {
      call.resolve({ ok: true, host: call.host ?? 'github.com', repos: [] });
    }
    await Promise.all(inFlight);
    expect(deps.state.authReposInFlight.size).toBe(0);
  });
});
