/**
 * Integration test for the no-project ephemeral single-file lifecycle (`ok <file>`).
 *
 * Spawns the REAL CLI in the exact shape the desktop's `spawnDetachedServer`
 * uses for an ephemeral session — `start --single-file <file> --project-dir
 * <temp> --serve-content-assets --react-shell-dist-dir <shell>` — and pins the
 * properties the desktop wiring (unit-tested in `window-manager-ephemeral.test.ts`)
 * cannot verify without a real server:
 *
 *   1. **No user-dir artifacts** — the server writes its `.ok/` state ONLY
 *      into the throwaway temp `projectDir`, NEVER into the file's real parent.
 *   2. **spawn pid === lock pid** — the desktop SIGTERMs the spawned pid; if the
 *      CLI forked the real server under a different pid, teardown would miss it
 *      and leak. (Same invariant `detached-lifecycle.test.ts` pins for projects.)
 *   3. **`/api/config` `singleFile: true`** — the renderer's chrome-gate signal.
 *   4. **Deterministic teardown** — SIGTERM (the desktop's
 *      `terminateServerByPid` ladder) reaps the server (lock releases); the temp
 *      dir is then removable and the file's parent stays byte-clean with the
 *      file persisted.
 *
 * Does NOT run Electron (mirrors `detached-lifecycle.test.ts`): the WindowManager
 * teardown wiring is unit-tested; this pins the REAL server behavior it relies on.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createEphemeralProjectDir, isProcessAlive } from '@inkeep/open-knowledge-server';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_MJS_PATH = resolve(HERE, '../../../cli/dist/cli.mjs');
const SHELL_DIST_PATH = resolve(HERE, '../../../cli/dist/public');

const LOCK_POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;

interface ServerLockMetadata {
  pid: number;
  port: number;
  worktreeRoot: string;
}

function readLock(lockDir: string): ServerLockMetadata | null {
  const lockPath = join(lockDir, 'server.lock');
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as ServerLockMetadata;
    return typeof parsed.port === 'number' && parsed.port > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function waitForLock(lockDir: string): Promise<ServerLockMetadata> {
  const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const lock = readLock(lockDir);
    if (lock) return lock;
    await wait(POLL_INTERVAL_MS);
  }
  throw new Error(`server.lock with a bound port did not appear at ${lockDir}`);
}

describe('ephemeral single-file lifecycle (real CLI)', () => {
  let userDir: string; // stands in for the user's real directory
  let notesDir: string; // the file's parent — the ephemeral contentDir
  let filePath: string; // the opened markdown file
  let tempProjectDir: string; // throwaway projectDir (where `.ok/` is allowed)
  let serverPid: number | null = null;

  beforeEach(async () => {
    userDir = await mkdtemp(resolve(tmpdir(), 'ok-ephemeral-it-'));
    notesDir = join(userDir, 'notes');
    mkdirSync(notesDir, { recursive: true });
    filePath = join(notesDir, 'todo.md');
    writeFileSync(filePath, '# Todo\n\n- one\n- two\n', 'utf-8');
    // Siblings that single-file scope must NOT index, and an asset.
    writeFileSync(join(notesDir, 'other.md'), '# Other\n', 'utf-8');
    writeFileSync(join(notesDir, 'pic.png'), 'not-a-real-png', 'utf-8');
    // The production helper — same synthesized `.ok/config.yml` the desktop uses.
    tempProjectDir = createEphemeralProjectDir(notesDir);
  });

  afterEach(async () => {
    if (serverPid !== null && isProcessAlive(serverPid)) {
      try {
        process.kill(serverPid, 'SIGKILL');
      } catch {
        // already gone
      }
      await wait(200);
    }
    serverPid = null;
    await rm(userDir, { recursive: true, force: true });
    await rm(tempProjectDir, { recursive: true, force: true });
  });

  test('boots with no user-dir artifacts (G4), reports singleFile, and tears down cleanly (G7)', async () => {
    if (!existsSync(CLI_MJS_PATH)) {
      throw new Error(`CLI dist not built at ${CLI_MJS_PATH}. Run 'bun run build' first.`);
    }

    const child = spawn(
      process.execPath,
      [
        CLI_MJS_PATH,
        'start',
        '--single-file',
        filePath,
        '--project-dir',
        tempProjectDir,
        '--port',
        '0',
        // Pin IPv4 so the `/api/config` probe below isn't subject to the
        // macOS `localhost` IPv6-first resolution (the production desktop uses
        // the `localhost` default; the host is irrelevant to G4 / teardown).
        '--host',
        '127.0.0.1',
        '--serve-content-assets',
        '--react-shell-dist-dir',
        SHELL_DIST_PATH,
        '--no-color',
      ],
      {
        env: { ...process.env, OK_LOCK_KIND: 'interactive', NODE_ENV: 'test' },
        detached: true,
        stdio: 'ignore',
        cwd: tempProjectDir,
      },
    );
    child.unref();
    serverPid = child.pid ?? null;
    expect(serverPid).not.toBeNull();

    const lockDir = join(tempProjectDir, '.ok', 'local');
    const lock = await waitForLock(lockDir);

    // The lock lives under the TEMP project root, and its pid is the process we
    // spawned (no fork) — the desktop SIGTERMs `handle.pid`, so this must hold or
    // teardown would miss the real server.
    expect(lock.worktreeRoot).toBe(tempProjectDir);
    expect(lock.pid).toBe(child.pid as number);

    // The file's real parent carries ONLY the user's files. No `.ok/`, no
    // sidecars. This is the load-bearing privacy/pollution property.
    expect(readdirSync(notesDir).sort()).toEqual(['other.md', 'pic.png', 'todo.md']);

    // `/api/config` advertises single-file mode for the renderer chrome gate.
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/config`, {
      headers: { Accept: 'application/json', Host: `127.0.0.1:${lock.port}` },
    });
    expect(res.status).toBe(200);
    const config = (await res.json()) as { singleFile?: boolean };
    expect(config.singleFile).toBe(true);

    // The desktop's teardown ladder: SIGTERM → the server releases its
    // lock (destroy()'s final step) and THEN the process exits a beat later.
    // Poll for BOTH within the deadline: asserting process-death the instant
    // the lock releases races that gap (the process is mid-exit, lock already
    // unlinked but the pid not yet reaped).
    process.kill(lock.pid, 'SIGTERM');
    const releaseDeadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
    let released = false;
    let exited = false;
    while (Date.now() < releaseDeadline) {
      const current = readLock(lockDir);
      if (current === null || current.pid !== lock.pid) released = true;
      if (!isProcessAlive(lock.pid)) exited = true;
      if (released && exited) break;
      await wait(POLL_INTERVAL_MS);
    }
    expect(released).toBe(true);
    expect(exited).toBe(true);
    serverPid = null; // reaped — afterEach must not SIGKILL

    // The temp projectDir is now removable (the desktop's `removeDir` step)...
    await rm(tempProjectDir, { recursive: true, force: true });
    expect(existsSync(tempProjectDir)).toBe(false);
    // ...and the user's directory is byte-clean, with the file intact.
    expect(readdirSync(notesDir).sort()).toEqual(['other.md', 'pic.png', 'todo.md']);
    expect(readFileSync(filePath, 'utf-8')).toBe('# Todo\n\n- one\n- two\n');
  }, 60_000);
});
