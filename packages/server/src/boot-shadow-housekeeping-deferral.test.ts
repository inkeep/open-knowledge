import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Boot-time shadow housekeeping (gc-config writes, rename-log GC/rebuild,
 * shadow maintenance) must not gate `ready`.
 *
 * Each of those legs is a burst of git subprocesses. On hosts where a process
 * spawn is expensive (Windows with AV real-time scanning taxes CreateProcess
 * at ~1s per spawn, on the event-loop thread), the serialized burst held
 * `ready` — and every `/api/*` handler gated on it — hostage for 60-90s after
 * every start, while `ok status` reported the server alive. Per-phase timeout
 * caps around the burst could not bound it, because the same spawn cost
 * starves the timers those caps rely on.
 *
 * Contract pinned here:
 *   1. `ready` settles while ALL THREE housekeeping legs are held open —
 *      each leg is blocked independently, so moving ANY of them back into the
 *      pre-ready path (not just the first) deadlocks this test on the vitest
 *      timeout.
 *   2. Housekeeping still runs after `ready` — deferral must not become
 *      deletion. Observed through the real path: every leg is invoked and the
 *      gc config lands in the shadow repo's config file.
 */

function makeGate() {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  return { held, release, calls: 0, readyHadSettledAtCall: null as boolean | null };
}

const gates = vi.hoisted(() => {
  const state = {
    readySettled: false,
    gcConfig: null as unknown as ReturnType<typeof makeGate>,
    renameGc: null as unknown as ReturnType<typeof makeGate>,
    maintenance: null as unknown as ReturnType<typeof makeGate>,
    /** When > 0, the gcRenameLog mock consumes one and returns `skipped: true`
     *  without forwarding — simulates a runtime GC owning the dedup slot. */
    renameGcSkipFirst: 0,
  };
  return state;
});

// Partial mocks: override only the three housekeeping entry points with
// hold-open gates; everything else stays real. initShadowRepo's own internal
// configureShadowGc call is not intercepted (intra-module reference), but the
// factory passes `deferGcConfig: true`, so the deferred runner is the only
// caller that matters.
vi.mock('./shadow-repo.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shadow-repo.ts')>();
  return {
    ...actual,
    configureShadowGc: vi.fn(async (shadow: unknown) => {
      gates.gcConfig.calls += 1;
      gates.gcConfig.readyHadSettledAtCall = gates.readySettled;
      await gates.gcConfig.held;
      return actual.configureShadowGc(shadow as Parameters<typeof actual.configureShadowGc>[0]);
    }),
  };
});

vi.mock('./rename-log.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rename-log.ts')>();
  return {
    ...actual,
    gcRenameLog: vi.fn(async (...args: Parameters<typeof actual.gcRenameLog>) => {
      gates.renameGc.calls += 1;
      gates.renameGc.readyHadSettledAtCall = gates.readySettled;
      if (gates.renameGcSkipFirst > 0) {
        gates.renameGcSkipFirst -= 1;
        return { scanned: 0, dropped: 0, retained: 0, rebuilt: 0, skipped: true };
      }
      await gates.renameGc.held;
      return actual.gcRenameLog(...args);
    }),
  };
});

vi.mock('./maintenance-coordinator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./maintenance-coordinator.ts')>();
  return {
    ...actual,
    createMaintenanceCoordinator: (
      ...args: Parameters<typeof actual.createMaintenanceCoordinator>
    ) => {
      const coordinator = actual.createMaintenanceCoordinator(...args);
      const originalRun = coordinator.runBootMaintenance.bind(coordinator);
      coordinator.runBootMaintenance = async () => {
        gates.maintenance.calls += 1;
        gates.maintenance.readyHadSettledAtCall = gates.readySettled;
        await gates.maintenance.held;
        return originalRun();
      };
      return coordinator;
    },
  };
});

import { createServer, type ServerInstance } from './server-factory.ts';

describe('createServer() — boot shadow housekeeping is deferred past ready', () => {
  let projectDir: string;
  let server: ServerInstance | null;

  beforeEach(async () => {
    gates.readySettled = false;
    gates.renameGcSkipFirst = 0;
    gates.gcConfig = makeGate();
    gates.renameGc = makeGate();
    gates.maintenance = makeGate();
    projectDir = await mkdtemp(join(tmpdir(), 'ok-boot-housekeeping-'));
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@example.com');
    await git.raw('commit', '--allow-empty', '-m', 'seed');
    server = null;
  });

  afterEach(async () => {
    // Release every gate before destroy: the destroy path drains the
    // in-flight housekeeping run, which would otherwise hang on a held gate.
    gates.gcConfig.release();
    gates.renameGc.release();
    gates.maintenance.release();
    await server?.destroy().catch(() => {});
    await rm(projectDir, { recursive: true, force: true });
  });

  test('ready settles while all three legs are held; housekeeping then completes', async () => {
    const srv = createServer({
      contentDir: projectDir,
      projectDir,
      quiet: true,
    });
    server = srv;
    void srv.ready.then(() => {
      gates.readySettled = true;
    });

    // With every housekeeping leg blocked indefinitely, ready must still
    // settle. A regression that re-awaits ANY leg pre-ready hangs here and
    // fails on the vitest timeout.
    await srv.ready;

    // Housekeeping is scheduled on a macrotask after ready's microtasks — let
    // the first leg start, then prove ready's settlement never waited on it.
    // Generous ceilings: a loaded CI worker can stretch scheduling latency.
    const wait = { timeout: 10_000, interval: 100 };
    await vi.waitFor(() => {
      expect(gates.gcConfig.calls).toBeGreaterThan(0);
    }, wait);
    expect(gates.gcConfig.readyHadSettledAtCall).toBe(true);

    // Deferral is not deletion: release the gates one at a time and watch
    // each subsequent leg run, post-ready, in order.
    gates.gcConfig.release();
    await vi.waitFor(() => {
      expect(gates.renameGc.calls).toBeGreaterThan(0);
    }, wait);
    expect(gates.renameGc.readyHadSettledAtCall).toBe(true);

    gates.renameGc.release();
    await vi.waitFor(() => {
      expect(gates.maintenance.calls).toBeGreaterThan(0);
    }, wait);
    expect(gates.maintenance.readyHadSettledAtCall).toBe(true);
    gates.maintenance.release();

    // The real configureShadowGc must land the gc config in the shadow repo.
    const shadowGitDir = join(projectDir, '.git', 'ok');
    await vi.waitFor(
      async () => {
        const sg = simpleGit({ timeout: { block: 10_000 } }).env({ GIT_DIR: shadowGitDir });
        const gcAuto = (await sg.raw('config', 'gc.auto')).trim();
        expect(gcAuto).toBe('512');
      },
      { timeout: 15_000, interval: 250 },
    );
  }, 30_000);

  test('the boot rebuild retries past skipped GC passes until one runs', async () => {
    // Simulate a runtime GC owning the per-gitDir dedup slot for the first
    // two boot-rebuild attempts. The loop must retry through them and land
    // the third call, not mistake a dropped pass for success.
    gates.renameGcSkipFirst = 2;
    gates.gcConfig.release();
    gates.renameGc.release();
    gates.maintenance.release();

    const srv = createServer({
      contentDir: projectDir,
      projectDir,
      quiet: true,
    });
    server = srv;
    await srv.ready;

    // Two skipped attempts (1s spacing) + the real third call.
    await vi.waitFor(
      () => {
        expect(gates.renameGc.calls).toBe(3);
      },
      { timeout: 15_000, interval: 100 },
    );
    // The chain proceeded past the retry loop to the maintenance leg.
    await vi.waitFor(
      () => {
        expect(gates.maintenance.calls).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 100 },
    );
  }, 30_000);

  test('an exhausted rebuild retry budget logs, gives up, and the chain continues', async () => {
    const prevInterval = process.env.OK_BOOT_RENAME_GC_RETRY_INTERVAL_MS;
    process.env.OK_BOOT_RENAME_GC_RETRY_INTERVAL_MS = '10';
    try {
      // Every attempt is swallowed by the dedup slot: the loop must stop at
      // its 30-attempt budget (not spin forever) and still reach the
      // maintenance leg rather than aborting the chain.
      gates.renameGcSkipFirst = Number.MAX_SAFE_INTEGER;
      gates.gcConfig.release();
      gates.renameGc.release();

      const srv = createServer({
        contentDir: projectDir,
        projectDir,
        quiet: true,
      });
      server = srv;
      await srv.ready;

      await vi.waitFor(
        () => {
          expect(gates.maintenance.calls).toBeGreaterThan(0);
        },
        { timeout: 15_000, interval: 100 },
      );
      expect(gates.renameGc.calls).toBe(30);
      gates.maintenance.release();
    } finally {
      if (prevInterval === undefined) delete process.env.OK_BOOT_RENAME_GC_RETRY_INTERVAL_MS;
      else process.env.OK_BOOT_RENAME_GC_RETRY_INTERVAL_MS = prevInterval;
    }
  }, 30_000);

  test('destroy() while the first leg is held stays bounded and cancels the later legs', async () => {
    const srv = createServer({
      contentDir: projectDir,
      projectDir,
      quiet: true,
      destroyTimeoutMs: 1_500,
    });
    server = srv;
    await srv.ready;

    // Let the first leg start and hold it open — a wedged git subprocess.
    await vi.waitFor(
      () => {
        expect(gates.gcConfig.calls).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 100 },
    );

    // destroy() must not hang on the held leg: the drain races
    // destroyTimeoutMs and abandons. The closed flag set by the drain then
    // cancels the not-yet-started legs when the held leg is finally released.
    await srv.destroy();
    server = null;
    expect(gates.renameGc.calls).toBe(0);
    expect(gates.maintenance.calls).toBe(0);

    gates.gcConfig.release();
    // Give the abandoned runner a beat: even once released, the closed flag
    // must keep the later legs from starting.
    await new Promise((r) => setTimeout(r, 250));
    expect(gates.renameGc.calls).toBe(0);
    expect(gates.maintenance.calls).toBe(0);
  }, 30_000);
});
