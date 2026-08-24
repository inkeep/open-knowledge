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
 * What the tests assert:
 *   1. The CLI bootstraps to a writeable `server.lock` with a non-zero port.
 *   2. The spawned pid is in a process group it owns (`pgid === pid`).
 *      This is the OS-level detachment property that decouples the server
 *      from Electron's process tree — closing the editor window or
 *      quitting Electron does not cascade SIGHUP/SIGTERM through this
 *      process group.
 *   3. An unref-ed detached child's death still reaches the parent, and the
 *      parent turns it into a `last-server-exit.json` on disk naming the
 *      exit code and the signal.
 *
 * Cleanup uses SIGKILL rather than SIGTERM-then-poll: production already
 * escalates to SIGKILL after `DEFAULT_SIGTERM_GRACE_MS` (`stopAllOwnedServers`),
 * a graceful-drain test is a separate concern, and a slow drain here would
 * only add flake to assertions that are not about shutdown.
 *
 * The test runs against the actually-built `packages/cli/dist/cli.mjs`. No
 * install hook produces it — `packages/cli` has no `prepare`/`postinstall`, so
 * `pnpm install` alone leaves it absent. The producer is this package's turbo
 * `test` task, whose `dependsOn: ["^build"]` builds `@inkeep/open-knowledge`
 * because `packages/desktop` depends on it via `workspace:*`. A bare
 * `vitest run --filter` bypasses that; run `pnpm build` from `packages/cli`
 * first, as the throw below says. When the build is absent the test fails loud,
 * because the absence of the CLI artifact IS a regression signal worth
 * surfacing.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { SERVER_EXIT_LOG } from '@inkeep/open-knowledge-core';
import { getLocalDir, isProcessAlive } from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { attachServerExitObserver } from '../../src/main/server-exit-observer.ts';
import {
  createServerExitRecorder,
  type ServerExitRecord,
} from '../../src/main/server-exit-record.ts';

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
  // `process.getpgid` is available on POSIX, including the macOS and Linux
  // environments where this lifecycle helper is exercised.
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
        `CLI dist not built at ${CLI_MJS_PATH}. Run 'pnpm build' from packages/cli first.`,
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
      // Cleanup — force-kill the detached server. SIGKILL rather than
      // SIGTERM-then-poll: production escalates to SIGKILL after
      // `DEFAULT_SIGTERM_GRACE_MS` anyway (`stopAllOwnedServers`), the
      // graceful-drain path is a separate test's concern, and waiting on a
      // drain here would only let cleanup flake mask the assertions above.
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

  /**
   * Pins the Node-level assumption the spawn-failure reporting rests on.
   *
   * `spawnDetachedServer` reports a child's exit code/signal by attaching an
   * `'exit'` listener and then calling `.unref()`. That is only sound if
   * `unref()` releases the event-loop reference WITHOUT detaching listeners —
   * true, but a semantic that is easy to regress by reordering the two calls,
   * and not something reading the code can confirm. A real detached child is
   * the only way to check it.
   *
   * Without this, a reordering would silently restore the original defect: the
   * parent again learns nothing about how the child died.
   */
  test('an unref-ed detached child still reports its exit code and signal', async () => {
    async function captureExit(
      args: string[],
    ): Promise<{ code: number | null; signal: string | null }> {
      const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
      await new Promise<void>((res, rej) => {
        child.once('spawn', res);
        child.once('error', rej);
      });

      // Same order as production: listener first, then unref.
      let exitRecord: { code: number | null; signal: string | null } | null = null;
      child.on('exit', (code, signal) => {
        exitRecord = { code, signal };
      });
      child.unref();

      const deadline = Date.now() + 10_000;
      while (exitRecord === null && Date.now() < deadline) {
        await wait(25);
      }
      if (exitRecord === null) throw new Error('child exit was never observed');
      return exitRecord;
    }

    expect(await captureExit(['-e', 'process.exit(3)'])).toEqual({ code: 3, signal: null });
  }, 30_000);

  test('a signal-killed detached child reports the signal, not an exit code', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((res, rej) => {
      child.once('spawn', res);
      child.once('error', rej);
    });

    let exitRecord: { code: number | null; signal: string | null } | null = null;
    child.on('exit', (code, signal) => {
      exitRecord = { code, signal };
    });
    child.unref();

    process.kill(child.pid as number, 'SIGKILL');

    const deadline = Date.now() + 10_000;
    while (exitRecord === null && Date.now() < deadline) {
      await wait(25);
    }
    expect(exitRecord).toEqual({ code: null, signal: 'SIGKILL' });
  }, 30_000);

  /**
   * Spawn a real detached child running `script`, wire it through the same
   * `attachServerExitObserver` production calls (over a real
   * `createServerExitRecorder`, registered before `unref()`), kill it with
   * `killWith` (or let it exit on its own when null), and return the record
   * that landed on disk plus everything the injected logger captured.
   *
   * Going through `attachServerExitObserver` rather than rebuilding the
   * registration by hand is what makes the exactly-one-line assertion below a
   * pin on production's wiring: a second listener added inside that function
   * would double the record and the log line here. What it still cannot reach
   * is that `index.ts` calls it at all — the bypass-pin in
   * `server-exit-wiring.test.ts` covers that.
   *
   * `lockDir` is derived with the same `getLocalDir` production uses rather
   * than a hand-written `.ok/local`, so the record is asserted at the path the
   * bundle collector harvests instead of at a duplicate of it.
   */
  async function recordDeathOf(
    script: string,
    killWith: NodeJS.Signals | null,
  ): Promise<{
    record: ServerExitRecord;
    infoLines: Array<Record<string, unknown>>;
    warnings: string[];
  }> {
    const lockDir = getLocalDir(tmpDir);
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
    await new Promise<void>((res, rej) => {
      child.once('spawn', res);
      child.once('error', rej);
    });

    const warnings: string[] = [];
    const infoLines: Array<Record<string, unknown>> = [];
    const recorder = createServerExitRecorder({
      now: () => new Date(),
      logger: { warn: (_payload, msg) => warnings.push(msg) },
    });

    // Production order: registered before unref(), and the pid read through the
    // child, both of which `attachServerExitObserver` owns.
    attachServerExitObserver(child, {
      lockDir,
      recordExit: (info) => {
        recorder.recordExit(info);
      },
      logger: { info: (payload) => infoLines.push(payload) },
    });
    child.unref();

    if (killWith !== null) process.kill(child.pid as number, killWith);

    const recordPath = join(lockDir, SERVER_EXIT_LOG);
    const deadline = Date.now() + 10_000;
    let lastParseError: unknown = null;
    while (Date.now() < deadline) {
      if (existsSync(recordPath)) {
        try {
          const record = JSON.parse(readFileSync(recordPath, 'utf-8')) as ServerExitRecord;
          return { record, infoLines, warnings };
        } catch (err) {
          // Partial write — wait and retry, same posture as `waitForLock`.
          // Retained so a serialization regression reports as "never parsed"
          // rather than as the file never showing up.
          lastParseError = err;
        }
      }
      await wait(25);
    }
    throw new Error(
      lastParseError === null
        ? `server exit record did not appear at ${recordPath}`
        : `server exit record at ${recordPath} never parsed: ${
            lastParseError instanceof Error ? lastParseError.message : String(lastParseError)
          }`,
    );
  }

  test('a SIGKILLed detached child leaves a record naming the signal', async () => {
    const { record, infoLines, warnings } = await recordDeathOf(
      'setTimeout(() => {}, 60000)',
      'SIGKILL',
    );

    expect(record.code).toBeNull();
    expect(record.signal).toBe('SIGKILL');
    expect(record.pid).toBeGreaterThan(0);
    expect(new Date(record.at).toISOString()).toBe(record.at);
    // One death, one line — not zero, and not doubled by the registration.
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0]).toMatchObject({
      event: 'server-exit.detached-child-exited',
      lockDir: getLocalDir(tmpDir),
      code: null,
      signal: 'SIGKILL',
    });
    // No `child-process-gone` reason can describe a plain spawn child, so the
    // detached path records none rather than borrowing another utility's, and
    // the record says which host observed it so a reader can tell that null
    // from a correlation window that produced nothing.
    expect(record.reason).toBeNull();
    expect(record.observer).toBe('detached-spawn');
    expect(warnings).toEqual([]);
  }, 30_000);

  test('a cleanly exiting detached child is distinguishable on disk', async () => {
    const { record } = await recordDeathOf('process.exit(0)', null);

    expect(record.code).toBe(0);
    expect(record.signal).toBeNull();
  }, 30_000);
});
