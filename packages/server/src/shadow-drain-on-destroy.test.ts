import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type ServerInstance } from './server-factory.ts';
import { type ShadowOpGate, shadowOpGateFor } from './shadow-op-gate.ts';
import { initShadowRepo, type ShadowHandle } from './shadow-repo.ts';

describe('createServer() — shadow mutator drain on destroy', () => {
  let projectDir: string;
  let shadow: ShadowHandle;
  let gate: ShadowOpGate;
  let server: ServerInstance | null;

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
    await git.raw('commit', '--allow-empty', '-m', 'seed');

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
