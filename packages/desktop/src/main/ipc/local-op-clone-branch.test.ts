/**
 * Coverage for branch threading in the IPC clone transport path.
 *
 * Symmetry contract with the HTTP clone path: when a share-receive flow
 * passes `branch` through `bridge.localOp.clone.start({url, dir, branch})`,
 * the main-process handler MUST forward it to `runCloneSubprocess` (so the
 * CLI runs `ok clone -b <branch>`), and MUST forward CLI-emitted
 * `branch-fallback` events to the renderer (so the share-receive controller
 * can render the "Branch X no longer exists" toast).
 *
 * The HTTP path already does both — branch threads through
 * `/api/local-op/clone` and `branch-fallback` flows back via the NDJSON
 * stream. Without the IPC path doing the same, share-receive in the
 * Navigator window silently clones the default branch.
 *
 * The module under test is `handleCloneStart` — its `runCloneSubprocess`
 * dependency is mocked at the module boundary so these tests never spawn a
 * subprocess. Each mock invocation captures `branch` + `onEvent` so we can
 * assert both the spawn-time wire and the runtime event forwarding.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { CloneEvent } from '@inkeep/open-knowledge-server';

interface CloneSpawn {
  url: string;
  dir: string;
  branch: string | null | undefined;
  onEvent: (event: CloneEvent) => void;
}

const cloneSpawns: CloneSpawn[] = [];

mock.module('@inkeep/open-knowledge-server', () => ({
  runAuthStatusSubprocess: () => Promise.resolve({ authenticated: false, host: 'github.com' }),
  runAuthReposSubprocess: () => Promise.resolve({ ok: false, error: 'unused' }),
  runDeviceFlowSubprocess: () => ({ done: Promise.resolve(), cancel: () => {} }),
  runCloneSubprocess: (opts: {
    url: string;
    dir: string;
    branch?: string | null;
    onEvent: (event: CloneEvent) => void;
  }) => {
    cloneSpawns.push({
      url: opts.url,
      dir: opts.dir,
      branch: opts.branch,
      onEvent: opts.onEvent,
    });
    return { done: new Promise<void>(() => {}), cancel: () => {} };
  },
  validateCloneInputs: () => ({ ok: true }),
}));

const { createLocalOpState, handleCloneStart } = await import('./local-op.ts');

interface CapturedSend {
  channel: string;
  payload: unknown;
}

function makeSender(captured: CapturedSend[]) {
  return {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      captured.push({ channel, payload });
    },
  };
}

function makeDeps() {
  return {
    resolveCliArgs: () => ['open-knowledge'],
    state: createLocalOpState(),
  };
}

describe('handleCloneStart — branch threading (IPC symmetry with HTTP path)', () => {
  test('forwards explicit branch into runCloneSubprocess', () => {
    cloneSpawns.length = 0;
    const deps = makeDeps();
    const sent: CapturedSend[] = [];
    const result = handleCloneStart(deps, makeSender(sent), {
      url: 'https://github.com/o/r.git',
      dir: '/tmp/r',
      branch: 'feat/foo',
    });
    expect(result.ok).toBe(true);
    expect(cloneSpawns).toHaveLength(1);
    expect(cloneSpawns[0]?.branch).toBe('feat/foo');
  });

  test('absent branch leaves runCloneSubprocess at legacy default-branch behavior', () => {
    cloneSpawns.length = 0;
    const deps = makeDeps();
    const sent: CapturedSend[] = [];
    const result = handleCloneStart(deps, makeSender(sent), {
      url: 'https://github.com/o/r.git',
      dir: '/tmp/r',
    });
    expect(result.ok).toBe(true);
    expect(cloneSpawns).toHaveLength(1);
    // Treated as "no branch" — either undefined or null is acceptable
    // (legacy back-compat invariant).
    const wired = cloneSpawns[0]?.branch;
    expect(wired === undefined || wired === null).toBe(true);
  });

  test('null branch leaves runCloneSubprocess at legacy default-branch behavior', () => {
    cloneSpawns.length = 0;
    const deps = makeDeps();
    const sent: CapturedSend[] = [];
    const result = handleCloneStart(deps, makeSender(sent), {
      url: 'https://github.com/o/r.git',
      dir: '/tmp/r',
      branch: null,
    });
    expect(result.ok).toBe(true);
    expect(cloneSpawns).toHaveLength(1);
    const wired = cloneSpawns[0]?.branch;
    expect(wired === undefined || wired === null).toBe(true);
  });

  test('forwards branch-fallback event to the renderer (HTTP-path parity)', () => {
    cloneSpawns.length = 0;
    const deps = makeDeps();
    const sent: CapturedSend[] = [];
    const result = handleCloneStart(deps, makeSender(sent), {
      url: 'https://github.com/o/r.git',
      dir: '/tmp/r',
      branch: 'feat/foo',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    cloneSpawns[0]?.onEvent({ type: 'branch-fallback', branch: 'feat/foo' });

    const cloneEvents = sent.filter((s) => s.channel === 'ok:local-op:clone:event');
    expect(cloneEvents).toHaveLength(1);
    expect(cloneEvents[0]?.payload).toEqual({
      streamId: result.streamId,
      event: { type: 'branch-fallback', branch: 'feat/foo' },
    });
  });

  test('forwards progress + complete events alongside branch-fallback', () => {
    cloneSpawns.length = 0;
    const deps = makeDeps();
    const sent: CapturedSend[] = [];
    const result = handleCloneStart(deps, makeSender(sent), {
      url: 'https://github.com/o/r.git',
      dir: '/tmp/r',
      branch: 'feat/foo',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const spawn = cloneSpawns[0];
    if (!spawn) throw new Error('expected spawn');
    spawn.onEvent({ type: 'progress', phase: 'Resolving deltas', pct: 50 });
    spawn.onEvent({ type: 'branch-fallback', branch: 'feat/foo' });
    spawn.onEvent({ type: 'complete', dir: '/tmp/r' });

    const cloneEvents = sent.filter((s) => s.channel === 'ok:local-op:clone:event');
    expect(cloneEvents).toHaveLength(3);
    expect(cloneEvents.map((e) => (e.payload as { event: { type: string } }).event.type)).toEqual([
      'progress',
      'branch-fallback',
      'complete',
    ]);
  });

  test('slashed-branch fallback round-trips verbatim through IPC', () => {
    cloneSpawns.length = 0;
    const deps = makeDeps();
    const sent: CapturedSend[] = [];
    const result = handleCloneStart(deps, makeSender(sent), {
      url: 'https://github.com/o/r.git',
      dir: '/tmp/r',
      branch: 'feature/long-branch-name',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    cloneSpawns[0]?.onEvent({
      type: 'branch-fallback',
      branch: 'feature/long-branch-name',
    });

    const cloneEvents = sent.filter((s) => s.channel === 'ok:local-op:clone:event');
    expect(cloneEvents[0]?.payload).toEqual({
      streamId: result.streamId,
      event: { type: 'branch-fallback', branch: 'feature/long-branch-name' },
    });
  });
});
