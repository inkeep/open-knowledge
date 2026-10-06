import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { getCallSites } from 'node:util';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { createServer, type ServerInstance, SHADOW_FANOUT_WARMUP_MS } from './server-factory.ts';
import { type ShadowOpGate, shadowOpGateFor } from './shadow-op-gate.ts';
import { FANOUT_INDEX_NAME, initShadowRepo, type ShadowHandle } from './shadow-repo.ts';

const serverFactoryPath = fileURLToPath(new URL('./server-factory.ts', import.meta.url));

const warmupObservers = vi.hoisted(
  () => new Map<string, (operation: { promise: Promise<string> }) => void>(),
);

vi.mock('./shadow-repo.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shadow-repo.ts')>();
  return {
    ...actual,
    buildWipTree: (...args: Parameters<typeof actual.buildWipTree>) => {
      const promise = actual.buildWipTree(...args);
      warmupObservers.get(args[0].gitDir)?.({ promise });
      return promise;
    },
  };
});

describe('createServer() — shadow mutator drain on destroy', () => {
  const heldReleases: Array<() => void> = [];
  let projectDir: string;
  let shadow: ShadowHandle;
  let gate: ShadowOpGate;
  let server: ServerInstance | null;
  let warmupStarted: Promise<{ promise: Promise<string> }>;

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    heldReleases.push(resolve);
    return { promise, resolve };
  }

  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ok-shadow-drain-'));
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    configureTestGitRepository(projectDir);
    expect
      .soft((await simpleGit(projectDir).listConfig('local')).all['maintenance.auto'])
      .toBe('false');
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@example.com');
    await git.raw('commit', '--allow-empty', '-m', 'seed');

    shadow = await initShadowRepo(projectDir);
    gate = shadowOpGateFor(shadow);
    warmupStarted = new Promise((resolve) => {
      warmupObservers.set(shadow.gitDir, resolve);
    });
    server = null;
  });

  afterEach(async () => {
    try {
      for (const release of heldReleases.splice(0)) release();
      await server?.destroy().catch(() => {});
      await gate.drain();
      await rm(projectDir, { recursive: true, force: true });
    } finally {
      warmupObservers.delete(shadow.gitDir);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  async function bootReady(destroyTimeoutMs: number): Promise<ServerInstance> {
    const srv = createServer({
      contentDir: projectDir,
      projectDir,
      quiet: true,
      shadowRepo: shadow,
      destroyTimeoutMs,
    });
    server = srv;
    await srv.ready;
    return srv;
  }

  async function boot(
    destroyTimeoutMs: number,
    signals: { afterReady?(): void; beforeReturn?(): void } = {},
  ): Promise<ServerInstance> {
    const srv = await bootReady(destroyTimeoutMs);
    signals.afterReady?.();
    await (await warmupStarted).promise;
    await gate.drain();
    signals.beforeReturn?.();
    return srv;
  }

  test('boot precondition joins a started fan-out write before mutator counts are asserted', async () => {
    const warmupEntered = deferred();
    const readyReached = deferred();
    const releaseWarmup = deferred();
    const schedule = globalThis.setTimeout;
    let triggerWarmup: (() => void) | undefined;
    vi.stubGlobal('setTimeout', ((callback: () => void, ms?: number, ...args: unknown[]) => {
      const caller = getCallSites(2)[1]?.scriptName;
      if (ms !== SHADOW_FANOUT_WARMUP_MS || !caller || normalize(caller) !== serverFactoryPath) {
        return schedule(callback, ms, ...args);
      }
      const timer = schedule(() => {}, ms);
      triggerWarmup = () => {
        clearTimeout(timer);
        callback();
      };
      return timer;
    }) as typeof setTimeout);

    const realWithMutator = gate.withMutator.bind(gate);
    let triggeringWarmup = false;
    let warmupFinished = false;
    vi.spyOn(gate, 'withMutator').mockImplementation((fn) => {
      if (!triggeringWarmup) return realWithMutator(fn);
      return realWithMutator(async () => {
        warmupEntered.resolve();
        await releaseWarmup.promise;
        const result = await fn();
        warmupFinished = true;
        return result;
      });
    });

    let bootReturnedBeforeWarmupFinished = false;
    try {
      const booted = boot(10_000, {
        afterReady: () => {
          triggeringWarmup = true;
          triggerWarmup?.();
          triggeringWarmup = false;
          readyReached.resolve();
        },
        beforeReturn: () => {
          bootReturnedBeforeWarmupFinished = !warmupFinished;
        },
      });
      await readyReached.promise;
      expect(triggerWarmup).toBeDefined();
      await warmupEntered.promise;
      releaseWarmup.resolve();
      const srv = await booted;
      await gate.drain();

      expect(warmupFinished).toBe(true);
      expect(gate.activeMutators).toBe(0);
      expect(bootReturnedBeforeWarmupFinished).toBe(false);
      await srv.destroy();
    } finally {
      releaseWarmup.resolve();
    }
  });

  test('boot precondition waits for a fan-out timer that has not fired at ready', async () => {
    const readyReached = deferred();
    const warmupEntered = deferred();
    const releaseWarmup = deferred();
    const schedule = globalThis.setTimeout;
    let triggerWarmup: (() => void) | undefined;
    let warmupTimerFired = false;
    vi.stubGlobal('setTimeout', ((callback: () => void, ms?: number, ...args: unknown[]) => {
      const caller = getCallSites(2)[1]?.scriptName;
      if (ms !== SHADOW_FANOUT_WARMUP_MS || !caller || normalize(caller) !== serverFactoryPath) {
        return schedule(callback, ms, ...args);
      }
      const timer = schedule(() => {}, ms);
      triggerWarmup = () => {
        clearTimeout(timer);
        warmupTimerFired = true;
        callback();
      };
      return timer;
    }) as typeof setTimeout);

    const realWithMutator = gate.withMutator.bind(gate);
    let triggeringWarmup = false;
    let warmupFinished = false;
    vi.spyOn(gate, 'withMutator').mockImplementation((fn) => {
      if (!triggeringWarmup) return realWithMutator(fn);
      return realWithMutator(async () => {
        warmupEntered.resolve();
        await releaseWarmup.promise;
        const result = await fn();
        warmupFinished = true;
        return result;
      });
    });

    let bootReturned = false;
    try {
      const booted = boot(10_000, {
        afterReady: readyReached.resolve,
        beforeReturn: () => {
          bootReturned = true;
        },
      });
      await readyReached.promise;
      expect(triggerWarmup).toBeDefined();
      expect(warmupTimerFired).toBe(false);
      expect(gate.activeMutators).toBe(0);
      await nextTurn();
      const returnedWhileTimerPending = bootReturned;

      triggeringWarmup = true;
      triggerWarmup?.();
      triggeringWarmup = false;
      await warmupEntered.promise;
      releaseWarmup.resolve();
      const srv = await booted;
      await gate.drain();

      expect(warmupTimerFired).toBe(true);
      expect(warmupFinished).toBe(true);
      expect(gate.activeMutators).toBe(0);
      expect(returnedWhileTimerPending).toBe(false);
      await srv.destroy();
    } finally {
      releaseWarmup.resolve();
    }
  });

  test('destroy() stays pending while a shadow mutator is in flight', async () => {
    const PROBE_MS = 1_000;
    const srv = await boot(10_000);

    const held = deferred();
    const mutator = gate.withMutator(() => held.promise);
    await tick();
    expect(gate.activeMutators).toBe(1);

    const destroyed = srv.destroy();
    const probe = await Promise.race([
      destroyed.then(() => ({ first: 'destroy' as const, mutators: gate.activeMutators })),
      delay(PROBE_MS).then(() => ({ first: 'probe' as const, mutators: gate.activeMutators })),
    ]);

    expect(probe.first).toBe('probe');
    expect(probe.mutators).toBe(1);

    held.resolve();
    await mutator;
    await destroyed;
    expect(gate.activeMutators).toBe(0);
  });

  test('destroy() cancels the pending fan-out warm-up so no shadow write lands after teardown', async () => {
    const nativeSchedule = globalThis.setTimeout;
    const nativeCancel = globalThis.clearTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const schedule = globalThis.setTimeout;
    const cancel = globalThis.clearTimeout;
    const controlledTimers = new Set<Parameters<typeof clearTimeout>[0]>();
    let warmupScheduled = false;
    let warmupFired = false;
    vi.stubGlobal('setTimeout', ((callback: () => void, ms?: number, ...args: unknown[]) => {
      const caller = getCallSites(2)[1]?.scriptName;
      if (ms !== SHADOW_FANOUT_WARMUP_MS || !caller || normalize(caller) !== serverFactoryPath) {
        return nativeSchedule(callback, ms, ...args);
      }
      warmupScheduled = true;
      const timer = schedule(() => {
        warmupFired = true;
        callback();
      }, ms);
      controlledTimers.add(timer);
      return timer;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
      if (controlledTimers.has(timer)) {
        cancel(timer);
      } else {
        nativeCancel(timer);
      }
    });
    const srv = await bootReady(10_000);
    const fanoutIndex = join(shadow.gitDir, FANOUT_INDEX_NAME);

    expect(warmupScheduled).toBe(true);
    expect(warmupFired).toBe(false);

    await srv.destroy();
    rmSync(fanoutIndex, { force: true });
    await vi.advanceTimersByTimeAsync(SHADOW_FANOUT_WARMUP_MS);
    await shadowOpGateFor(shadow).drain();

    expect(warmupFired).toBe(false);
    expect(existsSync(fanoutIndex)).toBe(false);
  });

  test('destroy() stays bounded when a shadow mutator never retires', async () => {
    const srv = await boot(300);

    const wedged = deferred();
    const mutator = gate.withMutator(() => wedged.promise);
    await tick();
    expect(gate.activeMutators).toBe(1);

    await srv.destroy();

    wedged.resolve();
    await mutator;
  });
});
