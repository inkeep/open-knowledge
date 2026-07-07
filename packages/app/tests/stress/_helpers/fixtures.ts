/**
 * Per-worker Playwright fixture.
 *
 * Replaces the previous single shared `webServer` block in
 * `playwright.config.ts` with a `{ scope: 'worker' }` fixture that spawns its
 * own `bun run dev` process on a kernel-allocated port + unique tmpdir per
 * worker. Eliminates cross-worker CPU contention on one shared Vite+Hocuspocus
 * instance (the residual flake class an earlier mitigation could not fully
 * eliminate).
 *
 * Architecture:
 *   - Primary precedent: React Router v7's `integration/playwright.config.ts`
 *     ships without a `webServer` entry; all server spawning lives in per-test
 *     fixtures using `get-port` + `cross-spawn` (no precedent for per-worker
 *     among Hocuspocus consumers — this migration is a new position).
 *   - Port allocation: kernel-assigned random port via `net.createServer(0)`
 *     (collision-free; matches the Tier 1 integration harness's
 *     `getFreePort()` primitive at `packages/app/tests/integration/test-harness.ts:62-70`).
 *   - Content dir: `mkdtempSync` keyed by `workerInfo.workerIndex` so each
 *     worker gets its own filesystem; pre-seeds `test-doc.md` +
 *     `sidebar-folder/nested-doc.md` which `reveal-on-activate.e2e.ts`
 *     depends on.
 *   - Ready detection: HTTP probe against `/` — more reliable than stdout
 *     regex parsing and consistent with the `waitForActiveProviderSynced`
 *     idiom.
 *
 * Fixtures exposed:
 *   - `workerServer` (worker-scoped): `{ port, baseURL, contentDir }` for the
 *     worker's dedicated dev server. Tests rarely consume this directly;
 *     prefer `baseURL` + `api` below.
 *   - `baseURL` (overrides Playwright built-in, test-scoped): worker's URL
 *     string. `page.goto('/foo')` automatically resolves against this.
 *   - `api` (test-scoped): seeding helpers `{ createPage, replaceDoc, seedDocs }`
 *     closed over the worker's baseURL. Replaces the previous free functions
 *     in `_helpers/editor-state.ts` that read `VITE_PORT` at call time.
 *
 * Usage in tests:
 *   ```ts
 *   import { expect, test } from './_helpers';
 *   test('foo', async ({ page, api }) => {
 *     await api.seedDocs([{ name: 'doc-a', markdown: '# A' }]);
 *     await page.goto('/#/doc-a');
 *     // ...
 *   });
 *   ```
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base } from '@playwright/test';
import {
  APP_PACKAGE_ROOT,
  checkCollabSync,
  closeServerLog,
  getFreePort,
  killGracefully,
  openServerLog,
  prepareViteCacheDir,
  tailServerLog,
  waitForHttpReady,
} from './server-process.ts';

export interface WorkerServer {
  /** Port the dev server is listening on. */
  port: number;
  /** `http://127.0.0.1:${port}` — the bound loopback literal. */
  baseURL: string;
  /** Absolute path to the worker's test content directory. */
  contentDir: string;
}

export interface AgentIdentity {
  agentId: string;
  agentName: string;
  clientName?: string;
  colorSeed?: string;
}

export interface ApiHelpers {
  /**
   * Create an empty document at `path` (e.g. `"doc-a.md"` or `"nested/x.md"`).
   * Returns quietly on HTTP 409 (already exists) so tests can re-seed safely.
   */
  createPage(path: string): Promise<void>;
  /**
   * Replace a document's entire contents with `markdown` via
   * `/api/agent-write-md`. The `position: 'replace'` body key is the required
   * contract — do NOT pass `mode: 'replace'` (silent fallback to append).
   */
  replaceDoc(docName: string, markdown: string): Promise<void>;
  /**
   * Replace a document's entire contents, authenticating as a specific agent
   * identity (distinct from the default 'claude-1'). Each call publishes a
   * presence entry on `__system__` awareness keyed by `agent-${agentId}`.
   * Use for E2E tests that drive multiple
   * concurrent agents.
   */
  writeAsAgent(docName: string, markdown: string, identity: AgentIdentity): Promise<void>;
  /**
   * Reset a specific document (or all documents if `docName` omitted) via
   * `/api/test-reset`. Isolates per-test CRDT + persistence state without
   * tearing down the whole worker.
   */
  testReset(docName?: string): Promise<void>;
  /**
   * Reset the worker's server and seed N unique docs. Every test that needs
   * a clean workspace should call this first.
   */
  seedDocs(docs: Array<{ name: string; markdown: string }>): Promise<void>;
}

type WorkerFixtures = {
  workerServer: WorkerServer;
  /** Per-file env override for the worker's dev server — see the option fixture below. */
  workerServerEnv: Record<string, string>;
};

type TestFixtures = {
  api: ApiHelpers;
};

/**
 * Phase 2 of the readiness probe: confirm the dev `/api/config` handler
 * is wired (not just the Vite SPA fallback). Phase 1's listener-up signal
 * (`waitForHttpReady` from `./server-process.ts`) implies the middleware
 * chain registered alongside `/collab` in the same `configureServer` pass;
 * this fetch validates the full path, including the JSON body shape the
 * editor expects from `api-config-handler.ts`'s response.
 */
async function checkApiConfig(baseURL: string, timeoutMs = 2_000): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseURL}/api/config`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`/api/config did not respond within ${timeoutMs}ms: ${String(err)}`);
  }
  if (res.status !== 200) {
    throw new Error(`/api/config returned status ${res.status}, expected 200`);
  }
  let body: {
    collabUrl?: unknown;
    previewUrl?: unknown;
    port?: unknown;
  } | null;
  try {
    body = (await res.json()) as typeof body;
  } catch (parseErr) {
    throw new Error(`/api/config returned 200 but body is not valid JSON: ${String(parseErr)}`);
  }
  if (
    !body ||
    typeof body.port !== 'number' ||
    (typeof body.collabUrl !== 'string' && body.collabUrl !== null)
  ) {
    throw new Error(`/api/config returned unexpected body shape: ${JSON.stringify(body)}`);
  }
}

/**
 * Three-phase readiness probe for the per-worker dev server. Fail-fast
 * under sustained host load instead of letting each in-test browser
 * also wait 30s for `Sync timed out`. Worst-case total budget:
 * 60 + 2 + 10 = 72s; phase 4 (`warmupAppFirstLoad` below) adds up to
 * 60 (goto) + 60 (treeitem) = 120s, for a 192s worst case within the worker
 * fixture's 240s timeout.
 * (`checkCollabSync` lives in `./server-process.ts`, shared with the
 * per-test fixtures.)
 */
async function waitForServerReady(baseURL: string, port: number): Promise<void> {
  // 60s first-boot tolerance — matches Playwright's own webServer default.
  // The previous 30s sat below the observed cold-boot tail under 4-worker
  // CI contention ('did not become ready within 30000ms' failures); the warm
  // seed cache makes the typical boot far faster, and the budget covers the
  // cold fallback.
  await waitForHttpReady(baseURL, 60_000);
  await checkApiConfig(baseURL);
  await checkCollabSync(port);
}

/**
 * Phase 4 of the readiness probe: one awaited, throwaway real-browser first
 * load, gated on the same app-interactive signal tests wait on (the
 * fixture-seeded treeitem). The server-facing phases above leave Vite's
 * per-process source-transform graph COLD — the per-run warm seed covers only
 * the dependency-optimizer cache — so without this phase the app's first-load
 * compile cost lands on whichever test runs first. On a retry that test is
 * the retried test itself (Playwright discards the failed worker and boots a
 * fresh replacement per retry), making retries structurally WEAKER than
 * first attempts and inverting the retry-as-recovery design
 * (`retries: 2` + `failOnFlakyTests: false` in playwright.config.ts).
 * Contract pinned by `tests/stress/harness-app-warmth.e2e.ts`.
 *
 * Fail-closed on purpose: an app that cannot render inside this budget
 * (2× the suite's 30s cold content budgets) would fail every test on the
 * worker anyway — failing here routes through the fixture's
 * readiness-failure path, which attaches the dev-server log tail instead
 * of surfacing as a per-test generic timeout.
 *
 * The gate waits on the first entry of `REQUIRED_FIXTURE_ENTRY_NAMES`
 * rendering in the sidebar tree. Any future `test.use({ workerServerEnv })`
 * whose env hides or empties the default sidebar at first paint would stall
 * every worker of that group here for the full budget — keep such envs
 * compatible with the seeded fixture entries rendering.
 */
const APP_WARMUP_GOTO_TIMEOUT_MS = 60_000;
const APP_WARMUP_TIMEOUT_MS = 60_000;

async function warmupAppFirstLoad(
  browser: import('@playwright/test').Browser,
  baseURL: string,
): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/`, { timeout: APP_WARMUP_GOTO_TIMEOUT_MS });
    await page
      .getByRole('treeitem', { name: REQUIRED_FIXTURE_ENTRY_NAMES[0], exact: true })
      .waitFor({ state: 'visible', timeout: APP_WARMUP_TIMEOUT_MS });
  } finally {
    await context.close();
  }
}

/**
 * Top-level content entries the worker fixture pre-seeds (see
 * `seedRequiredFixtureFiles`). Tests that bulk-clear the shared worker
 * contentDir (e.g. editor-tabs' `clearVisibleContentEntries`) MUST skip
 * these names: sibling tests on the same worker depend on them at navigate
 * time — file-tree-create's desktop-refresh restore (tab/row never appears
 * without them, the :295 cross-file interaction) and prop-upload's subdir
 * upload (cold `dirCount[sidebar-folder]` fails its precondition guard).
 */
export const REQUIRED_FIXTURE_ENTRY_NAMES = ['test-doc.md', 'sidebar-folder'] as const;

/**
 * Pre-seed the per-worker content directory with files that specific tests
 * depend on at navigate time (not created via /api/create-page in-test).
 *
 * Currently required by:
 *   - `file-tree-create.e2e.ts` desktop-refresh restore — opens tabs for
 *     both entries via the fake desktop session bridge.
 *   - `prop-upload.e2e.ts` subdir upload — needs the pre-seeded
 *     `sidebar-folder/nested-doc.md` so the content filter's
 *     `dirCount[sidebar-folder]` is warm (hard precondition guard in-test).
 *
 * If future tests add similar dependencies, extend
 * `REQUIRED_FIXTURE_ENTRY_NAMES` + this seeder in lock-step. Prefer
 * seeding via `api.seedDocs()` inside the test instead whenever possible.
 */
function seedRequiredFixtureFiles(contentDir: string): void {
  writeFileSync(join(contentDir, 'test-doc.md'), '', 'utf-8');
  mkdirSync(join(contentDir, 'sidebar-folder'), { recursive: true });
  writeFileSync(join(contentDir, 'sidebar-folder', 'nested-doc.md'), '', 'utf-8');
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  /**
   * Extra env vars for this worker's dev server. Playwright groups tests
   * into workers by option value, so a file that sets
   * `test.use({ workerServerEnv: {...} })` gets its own dedicated server
   * (+ contentDir + Vite cache) with those vars applied, while every file
   * that keeps the default `{}` shares the standard worker pool unchanged.
   * The load-bearing fixed vars (VITE_PORT, OK_TEST_CONTENT_DIR, ...) are
   * applied after the override and cannot be clobbered. First consumer:
   * `showall-lazy-tree.e2e.ts` drives a small `OK_SHOWALL_MAX_ENTRIES` so
   * the Show All truncation banner is reachable with a small fixture tree.
   */
  workerServerEnv: [{}, { scope: 'worker', option: true }],
  workerServer: [
    async ({ workerServerEnv, browser }, use, workerInfo) => {
      const port = await getFreePort();
      const contentDir = mkdtempSync(join(tmpdir(), `ok-w${workerInfo.workerIndex}-`));
      // Per-worker Vite optimized-dependency cacheDir — the third per-process
      // shared resource alongside the port and the content dir. Without it,
      // every spawned `bun run dev` falls back to Vite's default
      // `<root>/node_modules/.vite`, which the dependency optimizer is
      // single-writer over; cross-worker re-optimization deletes chunk files
      // that peer browsers are mid-import on, 404'ing `/src/main.tsx`'s ESM
      // graph and leaving `#root` blank for the full test budget.
      //
      // The cacheDir MUST live UNDER `node_modules/` so its absolute path
      // contains the substring `/node_modules/`. `@rolldown/plugin-babel`
      // (running the React Compiler preset) ships a default exclude of
      // `[/[/\\]node_modules[/\\]/]` against the source `id`, and every
      // file Vite hands the plugin from inside `cacheDir/deps/*.js` is the
      // esbuild-prebundled output of a node_modules dependency (hand-written
      // hook code in `@tanstack/react-query`, `sonner`, `react-dom`,
      // `@radix-ui/*`, etc.). When that path does NOT contain `node_modules`,
      // the babel plugin transforms it, the React Compiler panics on
      // patterns like `dispatcher.useState()[0]` or `var Toast = ...`, and
      // Vite serves an Internal Server Error for every dep URL. The page
      // never renders, every test in the worker times out, and the 15-min
      // CI job hits its hard ceiling. mkdtemp under `os.tmpdir()` (the
      // obvious first instinct) reproduces this failure mode end-to-end —
      // keep the per-worker cacheDir under `node_modules/` even though it
      // co-locates with the dependency install. Vite's own default
      // (`<root>/node_modules/.vite`) does the same; we just suffix per
      // worker so the directories do not collide.
      // `prepareViteCacheDir` mints the per-worker dir under node_modules
      // (preserving the babel-exclude path constraint documented above) and
      // copies the per-run warm seed built by `global-warm-cache.ts`, so
      // this worker's server boots with a pre-optimized dep cache instead
      // of running its own scan+optimize while three siblings do the same.
      const viteCacheDir = prepareViteCacheDir(`w${workerInfo.workerIndex}`);
      seedRequiredFixtureFiles(contentDir);
      const baseURL = `http://127.0.0.1:${port}`;

      // Vite's load-bearing boot diagnostics (dep-scan failures, restart
      // notices, "new dependencies optimized") go to stdout. Capture it to
      // a kernel-level file fd — no pipe backpressure (a `pipe` without a
      // consumer fills its 64KB buffer and hangs bun under verbose output),
      // and boot failures get the log tail attached below instead of the
      // old 'ignore' black hole.
      const serverLog = openServerLog(`w${workerInfo.workerIndex}`);

      // `--silent` suppresses bun's own banner + post-exit diagnostics
      // (e.g. `error: script "dev" exited with code 143` when teardown
      // SIGTERMs the dev server). The underlying script's stderr still
      // passes through, so real Vite errors continue to surface.
      const proc = spawn('bun', ['run', '--silent', 'dev', '--host', '127.0.0.1'], {
        cwd: APP_PACKAGE_ROOT,
        env: {
          ...process.env,
          ...workerServerEnv,
          VITE_PORT: String(port),
          OK_TEST_CONTENT_DIR: contentDir,
          OK_TEST_VITE_CACHE_DIR: viteCacheDir,
          // N concurrent worker boots must not each run predev's
          // `lingui compile` + `biome format --write` against the shared
          // src/locales catalogs — racing writers tear the JSON.
          // The warm-cache globalSetup boot compiles once
          // per run; the catalogs are committed + drift-checked.
          OK_TEST_SKIP_I18N_COMPILE: '1',
          // Opt the dev server into shadow-repo mode so /api/history and
          // /api/save-version work. Mirrors the integration harness's
          // gitEnabled:true path (test-harness.ts).
          OK_TEST_GIT_ENABLED: '1',
          // Silence the default `bun run dev` banner noise; most of it is
          // duplicated across 4 workers and clutters CI logs.
          NO_COLOR: process.env.NO_COLOR ?? '1',
        },
        // stdout → per-worker log file (see above); stderr stays 'inherit'
        // so real errors land in the Playwright worker log in real time.
        stdio: ['ignore', serverLog.fd, 'inherit'],
      });

      proc.on('error', (err) => {
        console.error(`[fixture w${workerInfo.workerIndex}] spawn error:`, err);
      });

      try {
        await waitForServerReady(baseURL, port);
        await warmupAppFirstLoad(browser, baseURL);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Same guard shape as the teardown below: cleanup must run even if
        // the kill throws a non-ESRCH error. The log file is deliberately
        // NOT removed here — the thrown message cites its path for triage.
        try {
          await killGracefully(proc);
        } finally {
          closeServerLog(serverLog);
          rmSync(contentDir, { recursive: true, force: true });
          rmSync(viteCacheDir, { recursive: true, force: true });
        }
        throw new Error(
          `${reason}\n--- dev server log tail (${serverLog.path}) ---\n${tailServerLog(serverLog)}`,
        );
      }

      await use({ port, baseURL, contentDir });

      // Cleanup must run even if killGracefully throws a non-ESRCH error —
      // a leaked viteCacheDir under node_modules accumulates prebundled
      // chunks with no reaper. Mirrors the per-test fixtures' teardown shape.
      try {
        await killGracefully(proc);
      } finally {
        closeServerLog(serverLog);
        rmSync(serverLog.path, { force: true });
        rmSync(contentDir, { recursive: true, force: true });
        rmSync(viteCacheDir, { recursive: true, force: true });
      }
    },
    // 240s: server boot probe (≤72s) + app first-load warmup (≤60s goto +
    // ≤60s treeitem = 120s) = 192s worst case, with 48s headroom under
    // 4-worker CI contention.
    { scope: 'worker', timeout: 240_000 },
  ],

  // Override Playwright's built-in `baseURL` so `page.goto('/foo')` resolves
  // against this worker's server, not a globally-configured one.
  baseURL: async ({ workerServer }, use) => {
    await use(workerServer.baseURL);
  },

  api: async ({ workerServer }, use) => {
    const { baseURL } = workerServer;
    // Ceiling per API call: a server that stalls mid-test should fail the
    // test NOW with the stalled endpoint named, not hang the bare fetch
    // until the worker/test timeout swallows which call hung. Generous vs
    // the <100ms healthy path so 4-worker CPU saturation can't trip it.
    const API_CALL_TIMEOUT_MS = 30_000;
    async function post(path: string, body?: unknown): Promise<Response> {
      try {
        return await fetch(`${baseURL}${path}`, {
          method: 'POST',
          ...(body !== undefined
            ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
          signal: AbortSignal.timeout(API_CALL_TIMEOUT_MS),
        });
      } catch (err) {
        // Only the timeout signal we created can abort this fetch; other
        // failures (ECONNREFUSED etc.) rethrow untranslated.
        const name = (err as { name?: string })?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new Error(
            `POST ${path} timed out after ${API_CALL_TIMEOUT_MS}ms — server stalled mid-test (port ${workerServer.port})`,
          );
        }
        throw err;
      }
    }
    const helpers: ApiHelpers = {
      async createPage(path: string): Promise<void> {
        const res = await post('/api/create-page', { path });
        if (res.status === 409) return;
        if (!res.ok) {
          throw new Error(`create-page failed for ${path}: ${res.status}`);
        }
      },
      async replaceDoc(docName: string, markdown: string): Promise<void> {
        const res = await post('/api/agent-write-md', { docName, markdown, position: 'replace' });
        if (!res.ok) {
          throw new Error(`agent-write-md failed for ${docName}: ${res.status}`);
        }
      },
      async writeAsAgent(docName: string, markdown: string, identity): Promise<void> {
        const res = await post('/api/agent-write-md', {
          docName,
          markdown,
          position: 'replace',
          agentId: identity.agentId,
          agentName: identity.agentName,
          clientName: identity.clientName,
          colorSeed: identity.colorSeed,
        });
        if (!res.ok) {
          throw new Error(
            `writeAsAgent failed for ${docName} / ${identity.agentId}: ${res.status}`,
          );
        }
      },
      async testReset(docName?: string): Promise<void> {
        const res = await post(
          docName ? `/api/test-reset?docName=${encodeURIComponent(docName)}` : '/api/test-reset',
        );
        if (!res.ok) {
          throw new Error(`test-reset failed${docName ? ` for ${docName}` : ''}: ${res.status}`);
        }
      },
      async seedDocs(docs: Array<{ name: string; markdown: string }>): Promise<void> {
        // Use the error-throwing helper rather than a bare fetch. A silent
        // test-reset failure (server not ready, transient error, alias
        // collision) would otherwise let createPage/replaceDoc operate on
        // stale CRDT state and produce a confusing intermittent failure
        // with no signal about the actual fault. Surface the reset error
        // loudly so triage finds it immediately.
        await helpers.testReset();
        for (const d of docs) await helpers.createPage(`${d.name}.md`);
        for (const d of docs) await helpers.replaceDoc(d.name, d.markdown);
      },
    };
    await use(helpers);
  },
});

export { expect } from '@playwright/test';
