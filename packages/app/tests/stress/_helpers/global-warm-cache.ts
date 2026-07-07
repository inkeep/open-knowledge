/**
 * Playwright globalSetup: build the per-run Vite optimizer seed cache.
 *
 * Boots ONE dev server against a fresh cacheDir, waits for the dependency
 * optimizer to settle (deps/_metadata.json present + deps dir quiet), then
 * promotes the dir to `VITE_E2E_SEED_DIR`. Every fixture-spawned server
 * (worker-scoped and per-test) copies the seed via `prepareViteCacheDir`,
 * so no server boots with a cold optimizer — see the seed-dir docblock in
 * `server-process.ts` for the flake classes a cold optimizer caused in CI.
 *
 * Keyed by the lockfile + the vite config inputs: a matching existing seed
 * is reused (fast local iteration); a mismatch rebuilds. The single seed
 * boot runs uncontended (before any worker exists), unlike the old
 * 4-concurrent-cold-boots shape, so the optimizer scan it depends on is
 * not racing three sibling boots for CPU.
 *
 * FAIL-OPEN: a warm failure logs and returns — workers then boot cold,
 * which is exactly the pre-seed status quo. It must never fail the run.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  APP_PACKAGE_ROOT,
  closeServerLog,
  getFreePort,
  killGracefully,
  openServerLog,
  tailServerLog,
  VITE_E2E_SEED_DIR,
  waitForHttpReady,
} from './server-process.ts';

const SEED_KEY_FILENAME = '.seed-key';
const OPTIMIZER_SETTLE_BUDGET_MS = 90_000;
const WARM_ATTEMPTS = 2;

function computeSeedKey(): string {
  const inputs = [
    join(APP_PACKAGE_ROOT, '..', '..', 'bun.lock'),
    join(APP_PACKAGE_ROOT, 'vite.config.ts'),
    join(APP_PACKAGE_ROOT, 'vite.dedupe.ts'),
    join(APP_PACKAGE_ROOT, 'vite.react-babel.ts'),
    join(APP_PACKAGE_ROOT, 'package.json'),
  ];
  const hash = createHash('sha256');
  for (const file of inputs) {
    hash.update(file);
    hash.update(existsSync(file) ? readFileSync(file) : 'absent');
  }
  return hash.digest('hex');
}

/** Cheap change-detector over the deps dir: names + sizes. */
function depsDirSignature(depsDir: string): string {
  try {
    return readdirSync(depsDir)
      .map((name) => {
        try {
          return `${name}:${statSync(join(depsDir, name)).size}`;
        } catch {
          return `${name}:?`;
        }
      })
      .sort()
      .join('|');
  } catch {
    return 'absent';
  }
}

async function buildSeedOnce(key: string): Promise<void> {
  const port = await getFreePort();
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-warm-cache-content-'));
  // Bun hoists deps to the workspace root; packages/app/node_modules may not
  // exist on cold CI runners, and globalSetup runs BEFORE any worker's
  // prepareViteCacheDir would create it — without this guard the seed build
  // ENOENTs on exactly the runners that need the warm cache most.
  mkdirSync(join(APP_PACKAGE_ROOT, 'node_modules'), { recursive: true });
  // Build in a sibling dir, promote atomically on success — a concurrent
  // local run reading a half-built seed would be worse than a cold boot.
  const buildDir = mkdtempSync(join(APP_PACKAGE_ROOT, 'node_modules', '.vite-e2e-seed-building-'));
  const log = openServerLog('warm-cache');
  const proc = spawn('bun', ['run', '--silent', 'dev', '--host', '127.0.0.1'], {
    cwd: APP_PACKAGE_ROOT,
    env: {
      ...process.env,
      VITE_PORT: String(port),
      OK_TEST_CONTENT_DIR: contentDir,
      OK_TEST_VITE_CACHE_DIR: buildDir,
      NO_COLOR: process.env.NO_COLOR ?? '1',
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  // An OS-level spawn failure (ENOENT, EPERM) surfaces as an 'error' EVENT,
  // not a throw — unhandled it crashes globalSetup and breaks the FAIL-OPEN
  // contract above. Same listener shape as the worker fixture's spawn.
  proc.on('error', (err) => {
    console.warn('[e2e warm-cache] spawn error:', err);
  });
  let succeeded = false;
  try {
    await waitForHttpReady(`http://127.0.0.1:${port}`, 60_000);
    // The optimizer runs eagerly from server start; wait for its metadata
    // and then for the deps dir to hold still across two consecutive polls.
    const depsDir = join(buildDir, 'deps');
    const metaPath = join(depsDir, '_metadata.json');
    const deadline = Date.now() + OPTIMIZER_SETTLE_BUDGET_MS;
    let lastSignature = '';
    let stablePolls = 0;
    while (Date.now() < deadline) {
      if (existsSync(metaPath)) {
        const signature = depsDirSignature(depsDir);
        if (signature === lastSignature) {
          stablePolls += 1;
          if (stablePolls >= 2) break;
        } else {
          stablePolls = 0;
          lastSignature = signature;
        }
      }
      await wait(1_000);
    }
    if (!existsSync(metaPath)) {
      throw new Error(
        `optimizer metadata never appeared within ${OPTIMIZER_SETTLE_BUDGET_MS}ms — server log tail:\n${tailServerLog(log)}`,
      );
    }
    // The deadline can expire with metadata present but the deps dir still
    // churning (a discovery round re-optimizing). Promoting a mid-mutation
    // seed would hand workers inconsistent chunks — the exact corruption
    // class the warm cache exists to remove. Throw instead; the fail-open
    // wrapper retries once and otherwise falls back to cold boots.
    if (stablePolls < 2) {
      throw new Error(
        `optimizer deps dir did not stabilize within ${OPTIMIZER_SETTLE_BUDGET_MS}ms (stablePolls=${stablePolls}) — server log tail:\n${tailServerLog(log)}`,
      );
    }
    writeFileSync(join(buildDir, SEED_KEY_FILENAME), key, 'utf-8');
    succeeded = true;
  } finally {
    // Kill BEFORE any buildDir cleanup: the server writes into buildDir (its
    // Vite cacheDir) until it exits, and the optimizer recreates a deleted
    // dir mid-write — orphaning it under node_modules/ with nothing to reap it.
    // Cleanup still runs if the kill throws a non-ESRCH error (same guard
    // shape as the worker-fixture teardown in fixtures.ts).
    try {
      await killGracefully(proc);
    } finally {
      closeServerLog(log);
      rmSync(contentDir, { recursive: true, force: true });
      if (!succeeded) {
        rmSync(buildDir, { recursive: true, force: true });
      }
    }
  }
  try {
    rmSync(VITE_E2E_SEED_DIR, { recursive: true, force: true });
    renameSync(buildDir, VITE_E2E_SEED_DIR);
    rmSync(log.path, { force: true });
  } catch (promoteErr) {
    // A failed promotion (e.g. ENOTEMPTY from a concurrent local run's
    // globalSetup re-creating the seed) would otherwise orphan buildDir
    // under node_modules with no reaper — the finally above only cleans it
    // on !succeeded. The build itself succeeded, so the log holds no
    // failure diagnostics; remove both and rethrow for the fail-open
    // wrapper to handle.
    rmSync(buildDir, { recursive: true, force: true });
    rmSync(log.path, { force: true });
    throw promoteErr;
  }
}

export default async function globalWarmViteCache(): Promise<void> {
  const key = computeSeedKey();
  const keyPath = join(VITE_E2E_SEED_DIR, SEED_KEY_FILENAME);
  const metaPath = join(VITE_E2E_SEED_DIR, 'deps', '_metadata.json');
  if (existsSync(keyPath) && existsSync(metaPath) && readFileSync(keyPath, 'utf-8') === key) {
    return;
  }
  for (let attempt = 1; attempt <= WARM_ATTEMPTS; attempt += 1) {
    try {
      await buildSeedOnce(key);
      return;
    } catch (err) {
      console.warn(
        `[e2e warm-cache] seed build attempt ${attempt}/${WARM_ATTEMPTS} failed${
          attempt === WARM_ATTEMPTS
            ? ' — workers will boot with a cold optimizer cache'
            : ', retrying'
        }: ${String(err)}`,
      );
    }
  }
}
