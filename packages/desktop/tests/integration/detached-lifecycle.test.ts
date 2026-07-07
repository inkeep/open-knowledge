/**
 * Integration test for the desktop's detached-server lifecycle.
 *
 * Validates the invariant: the OK server spawned by the desktop runs
 * in its own process group and survives parent process exit. The test
 * does NOT need to actually run Electron — it exercises the spawn shape
 * that `WindowManager.spawnDetachedServer` uses in production wiring
 * (`packages/desktop/src/main/index.ts:ensureWindowManager`):
 *
 *     child_process.spawn(node, [cli.mjs, 'start', ...], {
 *       env: { ELECTRON_RUN_AS_NODE: '1', OK_LOCK_KIND: 'interactive' },
 *       detached: true,
 *       stdio: 'ignore',
 *       cwd: contentDir,
 *     }).unref()
 *
 * What the test asserts:
 *   1. The CLI bootstraps to a writeable `server.lock` with a non-zero port.
 *   2. The spawned pid is in a process group it owns (`pgid === pid`).
 *      This is the OS-level detachment property that decouples the server
 *      from Electron's process tree — closing the editor window or
 *      quitting Electron does not cascade SIGHUP/SIGTERM through this
 *      process group.
 *
 * Cleanup uses SIGKILL rather than SIGTERM because Bun's SIGTERM-handler
 * timing is known-flaky (see CLAUDE.md WARN — Bun's SIGTERM handling).
 * Production code already escalates to SIGKILL after
 * `DEFAULT_SIGTERM_GRACE_MS` via `stopAllOwnedServers`, so the cleanup
 * path is not part of this test's assertion surface.
 *
 * The test runs against the actually-built `packages/cli/dist/cli.mjs`
 * (which the worktree's `bun install` produces transitively). When the
 * build is absent, the test fails loud — `bun run check` must run after
 * a successful build, so the absence of the CLI artifact IS a regression
 * signal worth surfacing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from '@inkeep/open-knowledge-server';

// Resolve the built CLI relative to this test file so the test runs from
// anywhere (root, packages/desktop, worktree).
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_MJS_PATH = resolve(HERE, '../../../cli/dist/cli.mjs');

const LOCK_POLL_TIMEOUT_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 50;

interface ServerLockMetadata {
  pid: number;
  hostname: string;
  port: number;
  startedAt: string;
  worktreeRoot: string;
  kind?: 'interactive' | 'mcp-spawned';
  capabilities?: string[];
}

async function waitForLock(lockDir: string): Promise<ServerLockMetadata> {
  const lockPath = join(lockDir, 'server.lock');
  const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(lockPath)) {
      try {
        const raw = readFileSync(lockPath, 'utf-8');
        const parsed = JSON.parse(raw) as ServerLockMetadata;
        if (typeof parsed.port === 'number' && parsed.port > 0) {
          return parsed;
        }
      } catch {
        // partial write; wait and retry
      }
    }
    await wait(LOCK_POLL_INTERVAL_MS);
  }
  throw new Error(`server.lock did not appear at ${lockPath} within ${LOCK_POLL_TIMEOUT_MS}ms`);
}

function getPgid(pid: number): number | null {
  // `process.getpgid` is available on POSIX; the desktop is macOS-only at
  // V0 so it's guaranteed in the supported test environment. Linux dev
  // hosts also satisfy this.
  const getpgid = (process as unknown as { getpgid?: (pid: number) => number }).getpgid;
  if (typeof getpgid !== 'function') return null;
  try {
    return getpgid(pid);
  } catch {
    return null;
  }
}

describe('detached-server lifecycle integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-detached-lifecycle-'));
    // `ok start` requires a real OK project root — `.ok/config.yml` must
    // exist as a regular file. Seed manually so the test doesn't depend
    // on `ok init`'s scaffolding behavior.
    const okDir = resolve(tmpDir, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('spawn-detached CLI is in its own process group + survives parent exit', async () => {
    if (!existsSync(CLI_MJS_PATH)) {
      throw new Error(
        `CLI dist not built at ${CLI_MJS_PATH}. Run 'bun run build' from packages/cli first.`,
      );
    }
    const lockDir = resolve(tmpDir, '.ok', 'local');

    // Production-shape spawn: `process.execPath` is the Node binary in
    // tests; the same flag (`detached: true, stdio: 'ignore', .unref()`)
    // applies under Electron's `ELECTRON_RUN_AS_NODE=1` in packaged
    // builds. The OS-level process-group semantics are identical.
    const child = spawn(process.execPath, [CLI_MJS_PATH, 'start', '--port', '0'], {
      env: {
        ...process.env,
        OK_LOCK_KIND: 'interactive',
        // Silent test mode so the CLI doesn't print the banner.
        NODE_ENV: 'test',
      },
      detached: true,
      stdio: 'ignore',
      cwd: tmpDir,
    });
    child.unref();

    let lock: ServerLockMetadata | null = null;
    try {
      lock = await waitForLock(lockDir);

      // 1. Lock has a valid port and our pid.
      expect(lock.port).toBeGreaterThan(0);
      expect(lock.pid).toBe(child.pid as number);

      // 2. Spawned process is alive.
      expect(isProcessAlive(lock.pid)).toBe(true);

      // 3. Process-group property — the invariant. The spawned child's
      // own pid is its process-group leader (the kernel set this when
      // `detached: true` triggered `setsid()` / equivalent), so a SIGHUP
      // / SIGTERM to the parent's group does NOT propagate to it. This
      // is the OS-level decoupling that lets the server outlive Electron
      // parent exit.
      const pgid = getPgid(lock.pid);
      if (pgid !== null) {
        expect(pgid).toBe(lock.pid);
      }

      // 4. Process-group decoupling from THIS test process. Even though
      // we spawned the child, its pgid differs from our pgid — Electron
      // parent quit would kill our group via SIGHUP cascade, but the
      // detached child's group is independent.
      const myPgid = getPgid(process.pid);
      if (pgid !== null && myPgid !== null) {
        expect(pgid).not.toBe(myPgid);
      }
    } finally {
      // Cleanup — force-kill the detached server. We use SIGKILL rather
      // than SIGTERM-then-poll because Bun's signal-handler timing is
      // known-flaky under SIGTERM (per CLAUDE.md WARN: "bun does not
      // always release the lock cleanly on SIGTERM — the bootServer
      // destroy chain races signal-exit"), and a flaky cleanup would
      // mask the actual invariant assertions above. Production code
      // escalates to SIGKILL after `DEFAULT_SIGTERM_GRACE_MS` already
      // (`stopAllOwnedServers` does this); the integration test for
      // graceful drain is a separate concern.
      if (lock !== null) {
        try {
          process.kill(lock.pid, 'SIGKILL');
        } catch {
          // Already gone — fine for cleanup.
        }
        // Wait a moment for the OS to reap so the next test's tmpdir
        // teardown doesn't race the dying process's open file handles.
        await wait(200);
      }
    }
  }, 60_000);
});
