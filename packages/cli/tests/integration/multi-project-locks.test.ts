/**
 * Multi-project lock isolation.
 *
 * Two layers of coverage:
 *   1. **Primitive (in-process):** `acquireProcessLock` called many times in
 *      ONE pid against many tmpdirs. Verifies the lock factory's per-lockDir
 *      isolation, idempotent same-pid rewrites, and updatePort isolation —
 *      these are real properties of the primitive even though same-pid
 *      acquires never trip the collision branch.
 *   2. **Cross-process (real):** spawn N independent worker processes
 *      (each with its OWN pid) holding their own server.lock + ui.lock.
 *      configuration that exercises the live-foreign-pid collision path:
 *      5 concurrent spawns across 5 content dirs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn as nativeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import {
  acquireProcessLock,
  isProcessAlive,
  type ProcessLockHandle,
  readProcessLock,
} from '@inkeep/open-knowledge-server';

interface ProjectHandles {
  lockDir: string;
  server: ProcessLockHandle;
  ui: ProcessLockHandle;
}

function makeProject(root: string, slug: string): ProjectHandles {
  const lockDir = join(root, slug, '.ok', LOCAL_DIR);
  mkdirSync(lockDir, { recursive: true });
  const metadata = { worktreeRoot: join(root, slug), startedAt: new Date().toISOString() };
  const server = acquireProcessLock({ lockName: 'server', lockDir, metadata });
  const ui = acquireProcessLock({ lockName: 'ui', lockDir, metadata });
  // Simulate the real `listen()` port advertisement — ok start gets a kernel
  // port, ok ui default 3000 + offset so ports across projects don't collide
  // by coincidence.
  const suffix = slug.slice(-1);
  const num = Number.parseInt(suffix, 10);
  server.updatePort(52000 + num);
  ui.updatePort(3000 + num);
  return { lockDir, server, ui };
}

describe('multi-project lock isolation (A1)', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = resolve(
      tmpdir(),
      `multi-project-locks-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('three concurrent projects produce six distinct live locks with unique ports', () => {
    const p1 = makeProject(testRoot, 'project-1');
    const p2 = makeProject(testRoot, 'project-2');
    const p3 = makeProject(testRoot, 'project-3');

    try {
      // All six lock files exist on disk
      for (const p of [p1, p2, p3]) {
        expect(existsSync(join(p.lockDir, 'server.lock'))).toBe(true);
        expect(existsSync(join(p.lockDir, 'ui.lock'))).toBe(true);
      }

      // Reads return the right project's metadata
      const s1 = readProcessLock({ lockDir: p1.lockDir, lockName: 'server' });
      const s2 = readProcessLock({ lockDir: p2.lockDir, lockName: 'server' });
      const s3 = readProcessLock({ lockDir: p3.lockDir, lockName: 'server' });
      const u1 = readProcessLock({ lockDir: p1.lockDir, lockName: 'ui' });
      const u2 = readProcessLock({ lockDir: p2.lockDir, lockName: 'ui' });
      const u3 = readProcessLock({ lockDir: p3.lockDir, lockName: 'ui' });

      for (const lock of [s1, s2, s3, u1, u2, u3]) {
        expect(lock).not.toBeNull();
        expect(lock?.pid).toBe(process.pid);
      }

      // Ports are all distinct across the six locks
      const ports = [s1, s2, s3, u1, u2, u3].map((l) => l?.port ?? 0);
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(6);
    } finally {
      for (const p of [p1, p2, p3]) {
        p.server.release();
        p.ui.release();
      }
    }
  });

  it('one project releasing does not affect the others', () => {
    const p1 = makeProject(testRoot, 'project-1');
    const p2 = makeProject(testRoot, 'project-2');

    try {
      p1.server.release();
      p1.ui.release();

      expect(existsSync(join(p1.lockDir, 'server.lock'))).toBe(false);
      expect(existsSync(join(p1.lockDir, 'ui.lock'))).toBe(false);

      // Project 2 unaffected
      expect(existsSync(join(p2.lockDir, 'server.lock'))).toBe(true);
      expect(existsSync(join(p2.lockDir, 'ui.lock'))).toBe(true);

      const s2 = readProcessLock({ lockDir: p2.lockDir, lockName: 'server' });
      expect(s2?.pid).toBe(process.pid);
      expect(s2?.port).toBeGreaterThan(0);
    } finally {
      p2.server.release();
      p2.ui.release();
    }
  });

  it('concurrent updatePort calls never cross-contaminate between projects', () => {
    const projects = Array.from({ length: 5 }, (_, i) => makeProject(testRoot, `project-${i}`));

    try {
      // Bump each project's ports a few times — simulates listen() returning
      // different ports on restart or a port-rebalance.
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < projects.length; i++) {
          projects[i].server.updatePort(60000 + i * 10 + round);
          projects[i].ui.updatePort(40000 + i * 10 + round);
        }
      }

      // Final port for each project should be its last write, not another's.
      for (let i = 0; i < projects.length; i++) {
        const s = readProcessLock({ lockDir: projects[i].lockDir, lockName: 'server' });
        const u = readProcessLock({ lockDir: projects[i].lockDir, lockName: 'ui' });
        expect(s?.port).toBe(60000 + i * 10 + 2);
        expect(u?.port).toBe(40000 + i * 10 + 2);
      }
    } finally {
      for (const p of projects) {
        p.server.release();
        p.ui.release();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-process coverage (the actual cross-process verification)
// ---------------------------------------------------------------------------

const LOCK_WORKER_PATH = resolve(__dirname, '_helpers', 'lock-worker.ts');
const WORKER_READY_TIMEOUT_MS = 5_000;
const WORKER_EXIT_TIMEOUT_MS = 3_000;

interface WorkerHandle {
  proc: ChildProcess;
  pid: number;
  lockDir: string;
  serverPort: number;
  uiPort: number;
}

interface WorkerReadyPayload {
  pid: number;
  serverPort: number;
  uiPort: number;
}

/**
 * Spawn the lock-worker as a real bun child process. The worker acquires both
 * locks for `lockDir`, prints a `READY {...}` line on stdout, then idles
 * waiting for SIGTERM. We resolve when the READY line lands, so the parent
 * test sees a fully-acquired lock state before it asserts.
 */
function spawnLockWorker(
  lockDir: string,
  serverPort: number,
  uiPort: number,
): Promise<WorkerHandle> {
  return new Promise((resolveSpawn, reject) => {
    const proc = nativeSpawn(
      'bun',
      ['run', LOCK_WORKER_PATH, lockDir, String(serverPort), String(uiPort)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (proc.pid === undefined || !proc.stdout || !proc.stderr) {
      reject(new Error('lock-worker spawn did not return a pid + pipes'));
      return;
    }

    let stderrBuffer = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf-8');
    });

    let stdoutBuffer = '';
    let resolved = false;
    const onData = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString('utf-8');
      const newlineIdx = stdoutBuffer.indexOf('\n');
      if (newlineIdx === -1) return;
      const line = stdoutBuffer.slice(0, newlineIdx).trim();
      if (!line.startsWith('READY ')) return;
      try {
        const payload = JSON.parse(line.slice('READY '.length)) as WorkerReadyPayload;
        resolved = true;
        proc.stdout?.removeListener('data', onData);
        clearTimeout(timeoutHandle);
        resolveSpawn({
          proc,
          pid: payload.pid,
          lockDir,
          serverPort: payload.serverPort,
          uiPort: payload.uiPort,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        reject(new Error(`lock-worker READY parse failed: ${(err as Error).message} :: ${line}`));
      }
    };
    proc.stdout.on('data', onData);

    const timeoutHandle = setTimeout(() => {
      if (!resolved) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        reject(
          new Error(
            `lock-worker did not emit READY within ${WORKER_READY_TIMEOUT_MS}ms (lockDir=${lockDir}, stderr=${stderrBuffer || '(empty)'})`,
          ),
        );
      }
    }, WORKER_READY_TIMEOUT_MS);
  });
}

/** SIGTERM the worker and await its exit. Falls back to SIGKILL on timeout. */
function stopLockWorker(handle: WorkerHandle): Promise<void> {
  return new Promise((resolveStop) => {
    let settled = false;
    const onExit = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimeout);
      resolveStop();
    };
    handle.proc.once('exit', onExit);
    try {
      handle.proc.kill('SIGTERM');
    } catch {
      // process may already be dead
    }
    const killTimeout = setTimeout(() => {
      try {
        handle.proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      // exit handler will resolveStop on the SIGKILL
    }, WORKER_EXIT_TIMEOUT_MS);
  });
}

// Skip-on-CI gate (oven-sh/bun#11892): cross-process lock workers spawn `bun` children;
// incomplete teardown on Linux GHA can keep the runner alive past `bun test` summary.
(process.env.CI ? describe.skip : describe)(
  'multi-project lock isolation — cross-process (A1)',
  () => {
    let testRoot: string;
    let workers: WorkerHandle[];

    beforeEach(() => {
      testRoot = resolve(
        tmpdir(),
        `multi-project-locks-xp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(testRoot, { recursive: true });
      workers = [];
    });

    afterEach(async () => {
      // Always clean up workers — leaking them across tests would deadlock CI.
      await Promise.all(workers.map(stopLockWorker));
      rmSync(testRoot, { recursive: true, force: true });
    });

    it('three concurrent worker processes each hold their own server+ui locks (no cross-contamination)', async () => {
      const lockDirs = [1, 2, 3].map((i) => {
        const lockDir = join(testRoot, `project-${i}`, '.ok', LOCAL_DIR);
        mkdirSync(lockDir, { recursive: true });
        return { i, lockDir, serverPort: 52100 + i, uiPort: 3100 + i };
      });

      workers = await Promise.all(
        lockDirs.map(({ lockDir, serverPort, uiPort }) =>
          spawnLockWorker(lockDir, serverPort, uiPort),
        ),
      );

      // Every worker is alive on this host.
      for (const w of workers) {
        expect(isProcessAlive(w.pid)).toBe(true);
      }

      // Every worker's pid is unique (3 distinct child processes).
      const workerPids = workers.map((w) => w.pid);
      expect(new Set(workerPids).size).toBe(3);

      // None share the parent's pid (these are real child processes, not
      // in-process idempotent rewrites).
      for (const pid of workerPids) {
        expect(pid).not.toBe(process.pid);
      }

      // The on-disk lock files match each worker's claimed pid + port — proves
      // the parent test process and any other worker did NOT overwrite a peer's
      // lock during concurrent acquisition.
      for (const w of workers) {
        const serverLockPath = join(w.lockDir, 'server.lock');
        const uiLockPath = join(w.lockDir, 'ui.lock');
        expect(existsSync(serverLockPath)).toBe(true);
        expect(existsSync(uiLockPath)).toBe(true);

        const serverLock = JSON.parse(readFileSync(serverLockPath, 'utf-8'));
        const uiLock = JSON.parse(readFileSync(uiLockPath, 'utf-8'));
        expect(serverLock.pid).toBe(w.pid);
        expect(serverLock.port).toBe(w.serverPort);
        expect(uiLock.pid).toBe(w.pid);
        expect(uiLock.port).toBe(w.uiPort);
      }

      // 6 distinct ports (3 server + 3 ui) — no collision across the fleet.
      const allPorts = workers.flatMap((w) => [w.serverPort, w.uiPort]);
      expect(new Set(allPorts).size).toBe(6);
    });

    it('a fourth worker against an already-held lockDir collides on the live foreign pid (US-001 collision branch)', async () => {
      const lockDir = join(testRoot, 'shared-project', '.ok', LOCAL_DIR);
      mkdirSync(lockDir, { recursive: true });

      const holder = await spawnLockWorker(lockDir, 52200, 3200);
      workers.push(holder);

      // A second worker against the SAME lockDir must fail to acquire — the
      // holder is alive and on the same host, so acquireProcessLock throws
      // ProcessLockCollisionError. The worker exits non-zero; we await that.
      const colliderProc = nativeSpawn('bun', ['run', LOCK_WORKER_PATH, lockDir, '52201', '3201'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let colliderStderr = '';
      colliderProc.stderr?.on('data', (chunk) => {
        colliderStderr += chunk.toString('utf-8');
      });
      const colliderExit = await new Promise<number>((resolveExit) => {
        colliderProc.once('exit', (code) => resolveExit(code ?? -1));
      });

      // Non-zero exit. The collision message includes the holder's pid.
      expect(colliderExit).not.toBe(0);
      expect(colliderStderr).toContain('acquire failed');
      expect(colliderStderr).toContain(`pid ${holder.pid}`);

      // Holder's lock is intact — collider did NOT overwrite it.
      const serverLock = JSON.parse(readFileSync(join(lockDir, 'server.lock'), 'utf-8'));
      expect(serverLock.pid).toBe(holder.pid);
      expect(serverLock.port).toBe(52200);
    });
  },
);
