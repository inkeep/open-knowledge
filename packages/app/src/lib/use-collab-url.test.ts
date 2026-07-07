/**
 * Tests for the pure `runCollabUrlPoll` primitive behind `useCollabUrl`.
 *
 * We exercise:
 *   (a) happy-path resolve (200 with collabUrl string → onStateChange fires
 *       once with resolved URL, no further ticks),
 *   (b) 404 fallback (same-origin defaultCollabWsUrl),
 *   (c) null-collab retry-until-terminal (one-shot info log, terminal fires
 *       once wall-clock elapses `terminalAfterMs`),
 *   (d) cancel() aborts in-flight and prevents subsequent ticks,
 *   (e) retry-like behavior — caller constructs a fresh loop with new deps
 *       to reset the wall-clock window (the hook does this via retrySignal).
 *
 * Uses a manual scheduler + virtual clock (same pattern as idle-shutdown
 * and ui safety-net) so tests are deterministic — no real wall-clock waits.
 */
import { describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import type { FetchApiConfigResult } from './api-config';
import { runCollabUrlPoll, TERMINAL_AFTER_MS } from './use-collab-url';

interface ManualScheduler {
  now: () => number;
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
  advanceTime: (ms: number) => Promise<void>;
  pendingCount: () => number;
}

function createManualScheduler(): ManualScheduler {
  type Entry = { id: number; cb: () => void; dueAt: number };
  const queue: Entry[] = [];
  let now = 0;
  let nextId = 1;
  return {
    now: () => now,
    setTimeout: (cb, ms) => {
      const id = nextId++;
      queue.push({ id, cb, dueAt: now + ms });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout: (handle) => {
      const id = handle as unknown as number;
      const idx = queue.findIndex((e) => e.id === id);
      if (idx >= 0) queue.splice(idx, 1);
    },
    async advanceTime(ms) {
      const target = now + ms;
      // Fire any due entries in order. Entries scheduled during a callback
      // can become due during the same advance, so loop until quiescent OR
      // we've exceeded a generous bound (prevents runaway self-rescheduling).
      for (let pass = 0; pass < 200; pass++) {
        const due = queue.filter((e) => e.dueAt <= target);
        if (due.length === 0) break;
        // Pop the earliest entry, step `now` to its dueAt, fire it, then
        // yield a microtask so any awaited fetch resolves before we check
        // the queue again.
        due.sort((a, b) => a.dueAt - b.dueAt);
        const next = due[0];
        if (!next) break;
        const idx = queue.indexOf(next);
        if (idx >= 0) queue.splice(idx, 1);
        now = next.dueAt;
        next.cb();
        await wait(0);
      }
      now = target;
    },
    pendingCount: () => queue.length,
  };
}

function makeDeps(overrides?: {
  fetchConfig?: (signal: AbortSignal) => Promise<FetchApiConfigResult>;
  fallbackUrl?: () => string;
  terminalAfterMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}) {
  const scheduler = createManualScheduler();
  const states: Array<{
    collabUrl: string | null;
    attempts: number;
    terminal: boolean;
    lastError: unknown;
  }> = [];
  const logged: Array<{ level: 'info' | 'warn'; msg: string }> = [];
  const deps = {
    fetchConfig:
      overrides?.fetchConfig ??
      (async (): Promise<FetchApiConfigResult> => ({
        status: 'ok' as const,
        config: { collabUrl: 'ws://localhost:52000/collab', previewUrl: null, port: 3000 },
      })),
    fallbackUrl: overrides?.fallbackUrl ?? (() => 'ws://localhost:5173/collab'),
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    onStateChange: (next: {
      collabUrl: string | null;
      attempts: number;
      terminal: boolean;
      lastError: unknown;
    }) => {
      states.push({ ...next });
    },
    terminalAfterMs: overrides?.terminalAfterMs,
    initialDelayMs: overrides?.initialDelayMs,
    maxDelayMs: overrides?.maxDelayMs,
    log: {
      info: (msg: string) => logged.push({ level: 'info', msg }),
      warn: (msg: string) => logged.push({ level: 'warn', msg }),
    },
  };
  return { deps, scheduler, states, logged };
}

describe('runCollabUrlPoll', () => {
  test('resolves healthy /api/config with a real collabUrl on first tick', async () => {
    const { deps, scheduler, states } = makeDeps();
    const handle = runCollabUrlPoll(deps);
    // The first tick's fetch is async — yield so it settles.
    await wait(0);
    await wait(0);

    expect(states.length).toBeGreaterThanOrEqual(1);
    const last = states[states.length - 1];
    expect(last?.collabUrl).toBe('ws://localhost:52000/collab');
    expect(last?.terminal).toBe(false);
    expect(last?.attempts).toBe(1);
    // No pending timer after a successful resolve — loop is done.
    expect(scheduler.pendingCount()).toBe(0);
    handle.cancel();
  });

  test('falls back to same-origin WS URL when /api/config is absent (404)', async () => {
    const { deps, states } = makeDeps({
      fetchConfig: async (): Promise<FetchApiConfigResult> => ({ status: 'absent' }),
      fallbackUrl: () => 'ws://localhost:5173/collab',
    });
    const handle = runCollabUrlPoll(deps);
    await wait(0);
    await wait(0);

    const last = states[states.length - 1];
    expect(last?.collabUrl).toBe('ws://localhost:5173/collab');
    handle.cancel();
  });

  test('retries on null-collab and emits exactly one info log across retries', async () => {
    let callCount = 0;
    const { deps, scheduler, states, logged } = makeDeps({
      fetchConfig: async (): Promise<FetchApiConfigResult> => {
        callCount += 1;
        if (callCount < 4) {
          return { status: 'ok', config: { collabUrl: null, previewUrl: null, port: 3000 } };
        }
        return {
          status: 'ok',
          config: { collabUrl: 'ws://localhost:52000/collab', previewUrl: null, port: 3000 },
        };
      },
    });
    runCollabUrlPoll(deps);
    // Initial null-collab tick settles.
    await wait(0);
    await wait(0);
    // Three null-collab retries at 2s / 4s / 8s, fourth tick resolves.
    await scheduler.advanceTime(2_100);
    await scheduler.advanceTime(4_100);
    await scheduler.advanceTime(8_100);

    const last = states[states.length - 1];
    expect(last?.collabUrl).toBe('ws://localhost:52000/collab');
    expect(callCount).toBe(4);

    // Exactly one info log across all null-collab ticks (latching prevents
    // log-spam on a long boot race).
    const infoLogs = logged.filter((l) => l.level === 'info');
    expect(infoLogs.length).toBe(1);
    expect(infoLogs[0]?.msg).toContain('no port yet');
  });

  test('transitions to terminal when TERMINAL_AFTER_MS elapses without resolution', async () => {
    const { deps, scheduler, states } = makeDeps({
      fetchConfig: async (): Promise<FetchApiConfigResult> => ({
        status: 'ok',
        config: { collabUrl: null, previewUrl: null, port: 3000 },
      }),
      terminalAfterMs: 1_000,
      initialDelayMs: 100,
      maxDelayMs: 400,
    });
    runCollabUrlPoll(deps);
    await wait(0);
    await wait(0);
    // Advance past the terminal deadline. Each tick reschedules with backoff
    // (100 → 200 → 400 → 400 ... capped).
    await scheduler.advanceTime(150);
    await scheduler.advanceTime(250);
    await scheduler.advanceTime(500);
    await scheduler.advanceTime(500);

    const terminal = states.find((s) => s.terminal === true);
    expect(terminal).toBeDefined();
    expect(terminal?.collabUrl).toBe(null);
    // No further timers pending after terminal fires — retries have stopped.
    expect(scheduler.pendingCount()).toBe(0);
  });

  test('TERMINAL_AFTER_MS default is 30s (matches doc constant)', () => {
    expect(TERMINAL_AFTER_MS).toBe(30_000);
  });

  test('cancel() aborts in-flight fetch and clears pending timer', async () => {
    let aborted = false;
    const { deps, scheduler } = makeDeps({
      fetchConfig: (signal: AbortSignal): Promise<FetchApiConfigResult> =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            const err = new Error('aborted') as Error & { name: string };
            err.name = 'AbortError';
            reject(err);
          });
        }),
      terminalAfterMs: 1_000,
    });
    const handle = runCollabUrlPoll(deps);
    // Let the fetch start.
    await wait(0);
    handle.cancel();
    await wait(0);

    expect(aborted).toBe(true);
    // No new state updates after cancel even if a timer would fire.
    const pendingBefore = scheduler.pendingCount();
    await scheduler.advanceTime(5_000);
    expect(scheduler.pendingCount()).toBeLessThanOrEqual(pendingBefore);
  });

  test('post-resolve: no further ticks are scheduled (terminal loop exit)', async () => {
    const { deps, scheduler } = makeDeps();
    runCollabUrlPoll(deps);
    await wait(0);
    await wait(0);

    expect(scheduler.pendingCount()).toBe(0);
    // Advance time far — nothing should fire.
    await scheduler.advanceTime(60_000);
    expect(scheduler.pendingCount()).toBe(0);
  });

  test('retry semantics — starting a second loop with fresh deps resets the wall-clock', async () => {
    // Simulates the hook's retry() path: the consumer constructs a new loop
    // (via retrySignal bump) with a fresh scheduler/window. We reuse the same
    // scheduler to verify the second loop's startedAt comes from `now()` at
    // second-loop time, not first-loop time.
    const {
      deps: deps1,
      scheduler,
      states: states1,
    } = makeDeps({
      fetchConfig: async (): Promise<FetchApiConfigResult> => ({
        status: 'ok',
        config: { collabUrl: null, previewUrl: null, port: 3000 },
      }),
      terminalAfterMs: 300,
      initialDelayMs: 50,
      maxDelayMs: 200,
    });
    const handle1 = runCollabUrlPoll(deps1);
    await wait(0);
    await wait(0);
    // Drive to terminal — tick times: 0, 50, 150, 350 (all null-collab).
    // At tick 4 (t=350), elapsed=350 ≥ 300 → terminal.
    await scheduler.advanceTime(60);
    await scheduler.advanceTime(110);
    await scheduler.advanceTime(250);
    expect(states1.some((s) => s.terminal)).toBe(true);
    handle1.cancel();

    // Now simulate retry — start a fresh loop at the current (advanced) clock.
    let fetchCalls = 0;
    const deps2 = {
      ...deps1,
      fetchConfig: async (): Promise<FetchApiConfigResult> => {
        fetchCalls += 1;
        return {
          status: 'ok' as const,
          config: {
            collabUrl: 'ws://localhost:54000/collab',
            previewUrl: null,
            port: 3000,
          },
        };
      },
    };
    const secondStates: Array<{
      collabUrl: string | null;
      attempts: number;
      terminal: boolean;
    }> = [];
    deps2.onStateChange = (next) => {
      secondStates.push({
        collabUrl: next.collabUrl,
        attempts: next.attempts,
        terminal: next.terminal,
      });
    };
    runCollabUrlPoll(deps2);
    await wait(0);
    await wait(0);

    // Second loop resolves on its first tick with the new URL — no carry-over
    // from the first loop's terminal state.
    expect(fetchCalls).toBe(1);
    const lastSecond = secondStates[secondStates.length - 1];
    expect(lastSecond?.collabUrl).toBe('ws://localhost:54000/collab');
    expect(lastSecond?.attempts).toBe(1);
    expect(lastSecond?.terminal).toBe(false);
  });

  test('network error is captured as lastError:{kind:error,code:network} and retried', async () => {
    let callCount = 0;
    const { deps, scheduler, states } = makeDeps({
      fetchConfig: async (): Promise<FetchApiConfigResult> => {
        callCount += 1;
        if (callCount === 1) throw new Error('network down');
        return {
          status: 'ok',
          config: { collabUrl: 'ws://localhost:52000/collab', previewUrl: null, port: 3000 },
        };
      },
      initialDelayMs: 100,
    });
    runCollabUrlPoll(deps);
    await wait(0);
    await wait(0);

    // First tick should have emitted lastError.kind=error, code=network.
    const firstErroredState = states.find(
      (s) =>
        (s as { lastError: unknown }).lastError !== null &&
        (s as { lastError: { kind: string; code: unknown } }).lastError?.kind === 'error',
    );
    expect(firstErroredState).toBeDefined();

    // Drive retry.
    await scheduler.advanceTime(150);
    await wait(0);

    const last = states[states.length - 1];
    expect(last?.collabUrl).toBe('ws://localhost:52000/collab');
    expect(callCount).toBe(2);
  });
});

describe('Electron host short-circuit (US-010)', () => {
  test('tryElectronBridge returns null when window is undefined', async () => {
    const { tryElectronBridge } = await import('./use-collab-url');
    expect(tryElectronBridge(undefined)).toBeNull();
  });

  test('tryElectronBridge returns null when window.okDesktop is undefined (web/CLI)', async () => {
    const { tryElectronBridge } = await import('./use-collab-url');
    expect(tryElectronBridge({})).toBeNull();
  });

  test('tryElectronBridge returns null when collabUrl is empty (Navigator-mode window)', async () => {
    const { tryElectronBridge } = await import('./use-collab-url');
    const fakeBridge = {
      config: {
        collabUrl: '',
        apiOrigin: '',
        projectPath: '',
        projectName: 'Navigator',
        mode: 'navigator' as const,
      },
      onProjectSwitched: () => () => {},
      onMenuAction: () => () => {},
      dialog: {
        openFolder: async () => null,
      },
      shell: {
        openExternal: async () => {},
      },
      clipboard: {
        writeText: async () => {},
      },
      platform: 'darwin' as const,
      appVersion: '0.0.0',
    };
    expect(tryElectronBridge({ okDesktop: fakeBridge })).toBeNull();
  });

  test('tryElectronBridge returns the bridge when collabUrl is populated', async () => {
    const { tryElectronBridge } = await import('./use-collab-url');
    const fakeBridge = {
      config: {
        collabUrl: 'ws://localhost:51234/collab',
        apiOrigin: 'http://localhost:51234',
        projectPath: '/tmp/p',
        projectName: 'p',
        mode: 'editor' as const,
      },
      onProjectSwitched: () => () => {},
      onMenuAction: () => () => {},
      dialog: {
        openFolder: async () => null,
      },
      shell: {
        openExternal: async () => {},
      },
      clipboard: {
        writeText: async () => {},
      },
      platform: 'darwin' as const,
      appVersion: '0.1.0',
    };
    const result = tryElectronBridge({ okDesktop: fakeBridge });
    expect(result).toBe(fakeBridge);
  });

  test('electronStateFromConfig produces the expected state shape', async () => {
    const { electronStateFromConfig } = await import('./use-collab-url');
    const state = electronStateFromConfig({
      collabUrl: 'ws://localhost:9999/collab',
      apiOrigin: 'http://localhost:9999',
      projectPath: '/tmp/q',
      projectName: 'q',
      mode: 'editor',
    });
    expect(state.collabUrl).toBe('ws://localhost:9999/collab');
    expect(state.attempts).toBe(0);
    expect(state.terminal).toBe(false);
    expect(state.lastError).toBeNull();
  });
});
