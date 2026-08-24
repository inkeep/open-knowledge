/**
 * Process-management helpers shared by worker-scoped (`fixtures.ts`) and
 * file-scoped e2e fixtures.
 *
 * Replaces previously file-private copies that drifted slightly:
 *   - `killGracefully` here is the errno-safe variant. `proc.kill()` can
 *     race a process exit between the `exitCode` check and the actual
 *     kill syscall — the unwrapped variant in earlier copies would throw
 *     `ESRCH` from cleanup teardown and replace the real test failure
 *     with a misleading post-test error. `EPERM` is the same race one step
 *     further along (the pgid was released and re-taken) and gets the same
 *     treatment; see `tolerateDuringTeardown` for why that is safe HERE and
 *     nowhere a supervisor lives.
 *   - `waitForHttpReady` requires an explicit `timeoutMs` so each fixture
 *     names its tolerance at the call site (worker-scoped fixtures pick
 *     ~30s for shared cached server; per-test fixtures pick ~60s for
 *     fresh tmpdir cold starts). No default — making the choice explicit
 *     prevents a third consumer from silently inheriting a stale value.
 */

import type { ChildProcess } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
/** `packages/app/` — every e2e fixture spawns `pnpm run dev` from here. */
export const APP_PACKAGE_ROOT = resolve(HELPERS_DIR, '..', '..', '..');

/**
 * Per-run warm seed for Vite's optimized-dependency cache, built once by
 * the `global-warm-cache.ts` globalSetup. Fixture-minted per-server cache
 * dirs copy from it so no dev server boots with a COLD optimizer: a cold
 * cacheDir forces a boot-time dependency scan + optimize (CPU-heavy ×
 * concurrent workers) and — when the scan dies mid-boot ("Failed to run
 * dependency scan … The server is being restarted or closed") — leaves
 * EVERY dep to lazy discovery, whose
 * mid-test "new dependencies optimized" full-page reloads were the
 * suite's dominant cross-cutting flake class (context-destroyed evaluates,
 * wedged clicks, 'ProseMirror editor not found').
 */
export const VITE_E2E_SEED_DIR = join(APP_PACKAGE_ROOT, 'node_modules', '.vite-e2e-seed');

/** The seed is usable only once the optimizer metadata landed in it. */
export function viteSeedIsReady(): boolean {
  return existsSync(join(VITE_E2E_SEED_DIR, 'deps', '_metadata.json'));
}

/**
 * Mint a per-server Vite cacheDir under `packages/app/node_modules/` and
 * warm it from the per-run seed when available. The dir MUST live under
 * `node_modules/` — `@rolldown/plugin-babel`'s default exclude matches the
 * path substring, and prebundled dep chunks served from a cacheDir outside
 * it get re-transformed by the React Compiler, which panics on prebundled
 * output (see the worker fixture's docblock in `fixtures.ts` for the full
 * post-mortem). A cold dir (seed absent or stale) is the pre-seed status
 * quo, not an error.
 */
export function prepareViteCacheDir(prefix: string): string {
  // Bun hoists deps to the workspace root; packages/app/node_modules may
  // not exist on cold CI runners. mkdtempSync requires the parent.
  mkdirSync(join(APP_PACKAGE_ROOT, 'node_modules'), { recursive: true });
  const dir = mkdtempSync(join(APP_PACKAGE_ROOT, 'node_modules', `.vite-${prefix}-`));
  if (viteSeedIsReady()) {
    cpSync(VITE_E2E_SEED_DIR, dir, { recursive: true, force: true });
  }
  return dir;
}

export interface ServerLog {
  path: string;
  fd: number;
}

/**
 * Open a log file to receive a spawned dev server's stdout. Vite logs the
 * load-bearing boot diagnostics (dep-scan failures, "server restarted",
 * "new dependencies optimized") to stdout, which the fixtures previously
 * discarded ('ignore') to avoid pipe-backpressure hangs — leaving boot
 * failures undiagnosable from CI. A kernel-level file fd has no
 * backpressure either, and the file gives `tailServerLog` something to
 * attach to readiness-failure errors.
 */
export function openServerLog(label: string): ServerLog {
  const path = join(
    tmpdir(),
    `ok-e2e-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`,
  );
  return { path, fd: openSync(path, 'w') };
}

export function closeServerLog(log: ServerLog): void {
  try {
    closeSync(log.fd);
  } catch {
    /* already closed */
  }
}

export function tailServerLog(log: ServerLog, lines = 40): string {
  try {
    const content = readFileSync(log.path, 'utf-8');
    return content.split('\n').slice(-lines).join('\n');
  } catch {
    return '(server log unreadable)';
  }
}

/**
 * Readiness phase: open a HocuspocusProvider on `__system__` and wait for
 * `synced`. Exercises the exact path that fails under heavy host CPU load —
 * a server whose /collab handshake can't complete within the budget would
 * otherwise fail per-test (30-60s × N) instead of once in fixture setup.
 * `connect: false` defers the WS open until the `synced` listener is
 * registered, eliminating a microtask race. The `finally` cleanup is
 * load-bearing: a leaked provider holds an awareness entry on the server
 * until the WS closes.
 */
export async function checkCollabSync(
  port: number,
  timeoutMs = 10_000,
  loopbackHost: '127.0.0.1' | '::1' = '127.0.0.1',
): Promise<void> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://${loopbackHost === '::1' ? '[::1]' : '127.0.0.1'}:${port}/collab`,
    name: SYSTEM_DOC_NAME,
    document: doc,
    connect: false,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`/collab sync round-trip did not complete within ${timeoutMs}ms`));
      }, timeoutMs);
      provider.on('synced', () => {
        clearTimeout(timer);
        resolve();
      });
      provider.connect();
    });
  } finally {
    // Wrap each cleanup independently — if `provider.destroy()` throws (e.g.
    // WebSocket in a bad state during teardown), `doc.destroy()` must still
    // run, AND the original timeout-rejection error from the try-block must
    // not be replaced by a less-useful destroy error in the finally-block.
    // Mirrors `provider-pool.ts` (production hot path).
    try {
      provider.destroy();
    } catch {
      /* best-effort cleanup */
    }
    try {
      doc.destroy();
    } catch {
      /* best-effort cleanup */
    }
  }
}

export { getFreePort } from '../../free-port.test-helper.ts';

export async function waitForHttpReady(baseURL: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseURL}/`, { signal: AbortSignal.timeout(1000) });
      // 200 (index.html) or 404 (unknown route) both prove the server is live.
      if (res.status === 200 || res.status === 404) return;
      lastErr = new Error(`unexpected status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await wait(250);
  }
  throw new Error(
    `dev server at ${baseURL} did not become ready within ${timeoutMs}ms. Last error: ${String(lastErr)}`,
  );
}

/**
 * The two signal errnos teardown reads as "nothing of ours is left to
 * signal". Anything else rethrows.
 *
 *   ESRCH — no process matched. The tree is already gone; the common case.
 *   EPERM — a process matched but is not ours to signal. `kill(2)` reports
 *     this for a whole group when no member could be signalled, so during
 *     teardown it means the pid being held is no longer the group that was
 *     spawned: the leader exited, the kernel released the pgid, and an
 *     unrelated process — on macOS often a hardened system one — now holds
 *     it. Either way nothing of ours survives, and throwing turns a finished,
 *     fully-passing run into a failed one.
 *
 * The tolerance is scoped to teardown, and the scoping is structural rather
 * than a convention someone has to remember: `killGracefully` is the only
 * caller of `killGroup`/`signalTree`, and every caller of `killGracefully` is
 * a fixture cleanup path. No live-supervision caller exists whose "is my child
 * still running?" answer this could corrupt. (`killGroup` and `signalTree` are
 * exported only so `tests/integration/kill-gracefully-errno.test.ts` can drive
 * this policy directly; a production caller appearing in that list is the
 * signal that this reasoning needs redoing.) Code that has to KEEP a child
 * alive must not copy this — there EPERM is real news (the pid was recycled
 * out from under it) and swallowing it would hide the bug.
 *
 * EPERM warns rather than passing silently. The residual risk is a tree that
 * really is still ours, still alive, and unsignalable, which leaks a dev
 * server; this line is the only trace such a leak would leave.
 */
function tolerateDuringTeardown(err: unknown, attempt: string): false {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ESRCH') return false;
  if (code === 'EPERM') {
    console.warn(`[e2e teardown] ${attempt} reported EPERM; treating the group as already gone`);
    return false;
  }
  throw err;
}

/**
 * Group-kill half of the tree contract: `kill(-pid)`, the one place that
 * discipline lives. Returns false when nothing of ours was signalled.
 */
export function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  // `kill(-pid)` only addresses a process group for a genuine pgid. `-0`
  // collapses to `kill(0, …)`, which signals OUR OWN group — the whole
  // Playwright run — and `-1` broadcasts to every process this user owns.
  // Node never yields pid 0 or 1 for a child, but the blast radius if it ever
  // did is the entire run, so refuse rather than trust the caller.
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    return tolerateDuringTeardown(err, `kill(-${pid}, ${signal})`);
  }
}

/**
 * Signal the spawned process TREE, not just the direct child. The dev-server
 * spawns are `pnpm run dev` — a shim whose actual server (vite) is a
 * descendant. SIGTERM to the shim is usually relayed, but SIGKILL never is
 * (the OS reaps the shim instantly), so a shim-only kill orphans a live Vite
 * that keeps the port bound and its file-watchers on the contentDir while
 * teardown rmSyncs that directory under it. Spawning `detached: true` gives
 * the child its own process group (pgid == pid), and `kill(-pid)` reaches
 * every descendant. A non-group child falls back to the direct kill: its pid
 * is not a pgid, so the group attempt reports ESRCH.
 *
 * Returns false when nothing was signalled (tree already gone).
 */
export function signalTree(proc: ChildProcess, signal: NodeJS.Signals): boolean {
  const pid = proc.pid;
  if (pid === undefined) return false;
  if (killGroup(pid, signal)) return true;

  // `ChildProcess.kill()` does not report failure the way `process.kill()`
  // does. It returns false on ESRCH without throwing, throws only for
  // EINVAL/ENOSYS (a bad signal name — a programming error, so let it out),
  // and routes every other errno, in practice EPERM, to an 'error' EVENT on
  // `proc`.
  //
  // Every spawn site does register an 'error' listener, but not one of them
  // routes the event through the policy above, and each fails differently:
  //   - `fixtures.ts` / `global-warm-cache.ts` hold a permanent `on('error')`
  //     that only logs, so a teardown EPERM prints as a `spawn error:` line
  //     blaming a spawn that in fact succeeded.
  //   - the two `.private.e2e.ts` fixtures arm `once('error', reject)` inside
  //     their readiness race. Reached from teardown that listener is either
  //     already spent (a pre-readiness spawn failure fired it, so the
  //     catch-path kill has no listener at all and an 'error' event with no
  //     listener is an uncaught throw), or still armed but pointed at a
  //     settled promise, where `reject` is a silent no-op.
  // So: crash on one path, misattributed log on the second, total silence on
  // the third. Capturing the event for the duration of this call is what
  // makes all three land on one policy. The boolean result is the honest
  // answer about whether a signal landed; the earlier shape discarded it and
  // reported success unconditionally.
  let emitted: Error | undefined;
  const capture = (err: Error) => {
    emitted = err;
  };
  proc.on('error', capture);
  let signalled: boolean;
  try {
    signalled = proc.kill(signal);
  } finally {
    proc.off('error', capture);
  }
  if (emitted !== undefined) return tolerateDuringTeardown(emitted, `child.kill(${signal})`);
  return signalled;
}

export async function killGracefully(proc: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    // The direct child already exited, but its group can still hold live
    // descendants (e.g. the pnpm shim crashed while Vite kept running).
    if (proc.pid !== undefined) killGroup(proc.pid, 'SIGKILL');
    return;
  }
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  // Exit races: the process can exit between the exitCode check above and
  // either kill() call. `signalTree` absorbs the errnos that mean the tree is
  // already gone, so cleanup teardown does not replace the real test result
  // (and the post-use rmSync still runs).
  if (!signalTree(proc, 'SIGTERM')) return;
  await Promise.race([exited, wait(timeoutMs)]);
  if (proc.exitCode === null && proc.signalCode === null) {
    // signalTree can report false for either tolerated errno, and neither
    // can hang the await. ESRCH means the child exited during the timeout
    // window. EPERM means the pid it holds is no longer ours — which requires
    // that pid to have been recycled, and a pid is only recycled once the
    // process holding it was reaped, so our child has exited on that branch
    // too. `exited` was armed before the first signal, so it is already
    // settled either way. The group-SIGKILL inside signalTree already reaped
    // any descendants — no further sweep needed.
    signalTree(proc, 'SIGKILL');
    await exited;
  } else if (proc.pid !== undefined) {
    // Graceful path: the shim exited on SIGTERM, but its relayed SIGTERM
    // does not always reach grandchildren — sweep the group.
    killGroup(proc.pid, 'SIGKILL');
  }
}
