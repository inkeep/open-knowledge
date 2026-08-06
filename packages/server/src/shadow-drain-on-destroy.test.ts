import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type ServerInstance } from './server-factory.ts';
import { type ShadowOpGate, shadowOpGateFor } from './shadow-op-gate.ts';
import { initShadowRepo, type ShadowHandle } from './shadow-repo.ts';

/**
 * `destroy()` must not release the shadow repo while mutators are still
 * writing into it.
 *
 * Checkpoint writers are fire-and-forget — the hot bridge paths schedule
 * `saveInMemoryCheckpoint` on a microtask and never await it — and each one
 * runs a chain of git subprocesses against the shadow gitDir. When `destroy()`
 * returned before those retired, a caller that removes the content directory
 * next (the integration harness does exactly that) raced them: the walk
 * emptied the tree, an in-flight mutator re-created the shadow gitDir inside
 * it, and the removal failed with ENOTEMPTY. It only surfaced under parallel
 * load, where both the removal walk and the subprocess chain stretch far
 * enough to overlap.
 *
 * These assert the invariant directly instead of trying to lose the race, so
 * they neither depend on contention nor reproduce it.
 */
describe('createServer() — shadow mutator drain on destroy', () => {
  let projectDir: string;
  let shadow: ShadowHandle;
  let gate: ShadowOpGate;
  let server: ServerInstance | null;

  /** A promise we settle by hand, to hold a mutator open for as long as we like. */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ok-shadow-drain-'));
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@example.com');
    // The shadow repo derives from a real project git repo, so give it one commit.
    await git.raw('commit', '--allow-empty', '-m', 'seed');

    // Own the handle here so the gate under test is provably the same object
    // the server's shutdown path resolves — `shadowOpGateFor` keys off gitDir.
    shadow = await initShadowRepo(projectDir);
    gate = shadowOpGateFor(shadow);
    server = null;
  });

  afterEach(async () => {
    await server?.destroy().catch(() => {});
    await rm(projectDir, { recursive: true, force: true });
  });

  async function boot(destroyTimeoutMs: number): Promise<ServerInstance> {
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

  test('destroy() stays pending while a shadow mutator is in flight', async () => {
    // Comfortably below the drain budget below, so a correct `destroy()` is
    // certain to still be waiting when the probe fires. The window can only
    // ever under-report a regression (if an unrelated shutdown step somehow
    // outran it) — it cannot fail a correct drain.
    const PROBE_MS = 1_000;
    const srv = await boot(10_000);

    const held = deferred();
    const mutator = gate.withMutator(() => held.promise);
    await tick();
    expect(gate.activeMutators).toBe(1);

    const destroyed = srv.destroy();
    // Read the mutator count in the same turn `destroy()` settles, so a late
    // release cannot mask an early return.
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

  test('destroy() stays bounded when a shadow mutator never retires', async () => {
    // Liveness half of the contract: the drain waits on the real writer, but a
    // wedged git subprocess must not hold the process open forever.
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
