/**
 * Process-management helpers shared by worker-scoped (`fixtures.ts`) and
 * file-scoped e2e fixtures.
 *
 * Replaces previously file-private copies that drifted slightly:
 *   - `killGracefully` here is the ESRCH-safe variant. `proc.kill()` can
 *     race a process exit between the `exitCode` check and the actual
 *     kill syscall — the unwrapped variant in earlier copies would throw
 *     `ESRCH` from cleanup teardown and replace the real test failure
 *     with a misleading post-test error.
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
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
/** `packages/app/` — every e2e fixture spawns `bun run dev` from here. */
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

/**
 * Probe the SAME loopback family the caller will bind: `127.0.0.1:p` and
 * `[::1]:p` are independent kernel slots, so a port verified free on one
 * family carries no guarantee about the other.
 */
export async function getFreePort(
  loopbackHost: '127.0.0.1' | '::1' = '127.0.0.1',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, loopbackHost === '::1' ? '::1' : '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

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

export async function killGracefully(proc: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  // ESRCH races: the process can exit between the exitCode check above and
  // either kill() call. Swallow ESRCH so cleanup teardown does not replace
  // the real test result (and the post-use rmSync still runs).
  try {
    proc.kill('SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    return;
  }
  await Promise.race([exited, wait(timeoutMs)]);
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill('SIGKILL');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
    await exited;
  }
}
