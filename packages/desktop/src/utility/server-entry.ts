/**
 * utilityProcess entry — hosts Hocuspocus via `bootServer()` per project window.
 *
 * Lifecycle:
 *   1. Module load: register IPC + signal handlers, start parent-death poll
 *   2. `init` IPC from main → call `bootServer({ ...opts, idleShutdownMs: null })`
 *   3. On `bootedServer.ready` → post `{ type: 'ready', port, apiOrigin }` back to main
 *   4. On `shutdown` IPC OR SIGTERM/SIGINT OR parent death → drain + exit
 *
 * Opt-outs: no `ok ui` sibling (BrowserWindow IS the UI), no idle-shutdown
 * (BrowserWindow lifecycle owns this utility's lifetime).
 *
 * Parent-death detection: macOS has no PR_SET_PDEATHSIG, so we poll
 * `process.kill(parentPid, 0)` every 5s. If the parent dies (`EPERM` /
 * `ESRCH`), self-exit cleanly so the server.lock is released. The portable
 * polling fallback runs on Linux and Windows too.
 *
 * Guard: this module MUST NOT import `attachIdleShutdown` from anywhere.
 * A Biome GritQL rule will eventually enforce this; the comment is the
 * human-side reminder.
 */

import { rename, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  detectGh,
  getNativeTomlMcpEditor,
  loadConfig,
  makeLazyProbeTokenStore,
  probeOwnManagedEditorMcpEntry,
} from '@inkeep/open-knowledge';
import { resolveServerRuntimeConfig, type ServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import {
  type BootedServer,
  type BootServerOptions,
  type Config,
  ConfigSchema,
  ensureProjectGit,
  initContent,
  makeLazyEmbeddingsKeyStore,
} from '@inkeep/open-knowledge-server';
import { type KeyringSmokeResult, runKeyringSmoke } from './keyring-smoke.ts';

export type { KeyringSmokeResult } from './keyring-smoke.ts';

/** IPC payload shapes (utility ↔ main). */
export interface UtilityInitMessage {
  type: 'init';
  opts: Pick<
    BootServerOptions,
    | 'contentDir'
    | 'projectDir'
    | 'port'
    | 'host'
    | 'debounce'
    | 'maxDebounce'
    | 'localOpCliArgs'
    | 'reactShellDistDir'
  > & {
    /**
     * Main process signals it already ran `ensureProjectGit(projectDir)`. When
     * `true`, the utility skips the call (idempotent re-run is safe but
     * unnecessary). Default `false` — utility runs the (idempotent) check
     * itself, which is the safe default for callers that don't pre-init.
     */
    didEnsureGit?: boolean;
    /**
     * Version stamp of the consent dialog payload. Lets us bump the contract
     * later without breaking persisted preferences. Default `1`.
     */
    consentVersion?: number;
  };
}
export interface UtilityShutdownMessage {
  type: 'shutdown';
}
/**
 * Main → utility request to run the keyring smoke. `correlationId` is
 * echoed back on the result message so concurrent requests resolve
 * independently.
 */
export interface UtilityDebugKeyringSmokeMessage {
  type: 'debug-keyring-smoke';
  correlationId: string;
}
export type UtilityIncomingMessage =
  | UtilityInitMessage
  | UtilityShutdownMessage
  | UtilityDebugKeyringSmokeMessage;

export interface UtilityReadyMessage {
  type: 'ready';
  port: number;
  apiOrigin: string;
}
export interface UtilityErrorMessage {
  type: 'error';
  message: string;
  stack?: string;
  /**
   * Distinguishes recoverable failure modes from generic errors so the
   * main process can pick a remediation path (auto-kill an MCP-spawned
   * lock holder vs. show a user dialog vs. log-only). Absent for the
   * default "something else went wrong" case — main treats it as the
   * existing showErrorBox path.
   */
  kind?: 'lock-collision' | 'mcp-server-stuck' | 'mcp-server-killed';
  /**
   * Present only on `kind: 'lock-collision'`. Lets the main process
   * inspect the colliding lock's `kind` / `port` and decide whether to
   * auto-kill (mcp-spawned) or surface a dialog (interactive).
   */
  existingLock?: {
    pid: number;
    hostname: string;
    port: number;
    startedAt: string;
    worktreeRoot: string;
    kind?: 'interactive' | 'mcp-spawned';
    capabilities?: string[];
  };
}
export interface UtilityDegradedMessage {
  type: 'degraded';
  subsystems: readonly string[];
}
/**
 * Utility → main keyring-smoke result. Pairs with a prior
 * `UtilityDebugKeyringSmokeMessage`; the main-side relay matches by
 * `correlationId`.
 */
export interface UtilityDebugKeyringSmokeResultMessage {
  type: 'debug-keyring-smoke-result';
  correlationId: string;
  result: KeyringSmokeResult;
}
export type UtilityOutgoingMessage =
  | UtilityReadyMessage
  | UtilityErrorMessage
  | UtilityDegradedMessage
  | UtilityDebugKeyringSmokeResultMessage;

/**
 * Test seam — the entry script runs `setupUtility(...)` with real `parentPort` /
 * `process` deps; tests run it with mocks. Pure factory, no top-level side
 * effects.
 */
export interface SetupUtilityDeps {
  /** `process.parentPort` from utilityProcess context. Null in non-utility runtime. */
  parentPort: {
    on(event: 'message', handler: (event: { data: unknown }) => void): void;
    postMessage(value: UtilityOutgoingMessage): void;
  } | null;
  /** Function to import @inkeep/open-knowledge-server (injected so tests can mock). */
  importServer: () => Promise<typeof import('@inkeep/open-knowledge-server')>;
  /** `process.exit` injection for tests. */
  exit: (code: number) => void;
  /** Initial parent pid to monitor. Pass `process.ppid` from real entry. */
  parentPid: number;
  /** `process.kill(pid, signal)` injection. Tests pass a no-op or a tracker. */
  killProbe: (pid: number, signal: number | string) => void;
  /** Signal subscription for SIGTERM/SIGINT. */
  onSignal: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void;
  /**
   * `setInterval` (injectable for tests). Returns a handle that supports
   * `clear()` so `stopParentPoll` can actually stop the interval — required
   * for test lifecycle and for any future shutdown path that doesn't
   * immediately exit the process.
   */
  setInterval: (cb: () => void, ms: number) => { unref?: () => void; clear: () => void };
  /** Poll cadence for parent-death check (ms). Default 5000. */
  parentPollMs?: number;
  /**
   * Keyring smoke runner — injectable for tests. Production defaults to
   * `runKeyringSmoke` from `./keyring-smoke.ts`.
   */
  runSmoke?: () => Promise<KeyringSmokeResult>;
  /**
   * Environment provider — `process.env` in production. Tests inject a
   * plain object so `OK_DEBUG_KEYRING_SMOKE*` can be toggled per test
   * without leaking into sibling tests.
   */
  env?: Record<string, string | undefined>;
  /**
   * Atomic file writer for the boot-time smoke output. Production writes
   * via `fs.promises.writeFile` to a tmp path then `rename` to the final
   * path. Tests inject a spy so output filename and payload can be asserted
   * without touching the filesystem.
   */
  writeSmokeResult?: (path: string, contents: string) => Promise<void>;
  /**
   * Test seam for the per-init pre-bootServer pipeline: ensure-git → scaffold
   * → load config → resolve contentDir. Production runs `ensureProjectGit`,
   * `initContent`, `resolveDesktopServerRuntime`, and `resolveContentDir`
   * against the real filesystem. Tests inject a stub so unit assertions never
   * touch disk.
   */
  prepareBootEnvironment?: PrepareBootEnvironment;
}

/**
 * Return shape for the per-init pre-bootServer prelude. `contentRoot` is the
 * raw `config.content.dir` value (passed through to `bootServer` so its
 * `<projectDir>/<contentRoot>/.ok/local/server.lock` resolution matches the
 * CLI wrapper); `contentDir` is the absolute resolved path.
 */
export interface PreparedBootEnvironment {
  config: Config;
  contentDir: string;
  contentRoot: string | undefined;
  configValid: boolean;
  /**
   * The scope-correctly-resolved `server.*` runtime (bind list, externalUrl,
   * exposure consent), passed to `bootServer` so exposure consent is honored
   * only from the project-local layer. Without an explicit `serverRuntime`,
   * `bootServer` forces `allowExternal` off and desktop is loopback-only by
   * construction.
   */
  serverRuntime: ServerRuntimeConfig;
  /**
   * Defense-in-depth signals appended to `bootServer`'s `degraded` array.
   * Today's only producer: `'project-git-shell-only'` when the prelude's
   * `ensureProjectGit` call repaired a shell `.git/`. Surfaced via
   * `UtilityDegradedMessage` so main can correlate post-boot symptoms.
   */
  degradedHints?: readonly string[];
}

export type PrepareBootEnvironment = (
  ipcOpts: UtilityInitMessage['opts'],
) => Promise<PreparedBootEnvironment>;

export interface UtilityHandle {
  /** Resolves once the utility has booted (after `ready` IPC fired). Tests await this. */
  readyPromise: Promise<UtilityReadyMessage>;
  /** Cancel the parent-death polling interval (called on shutdown). */
  stopParentPoll(): void;
  /** Run the drain sequence + exit. Idempotent. */
  shutdown(reason: string): Promise<void>;
}

/**
 * Wire up the utility-process IPC + lifecycle. Called once at module load with
 * real deps in production; tests call it with mocks to assert each branch.
 */
export function setupUtility(deps: SetupUtilityDeps): UtilityHandle {
  let booted: BootedServer | null = null;
  let parentPollHandle: { unref?: () => void; clear: () => void } | null = null;
  let shuttingDown = false;
  let resolveReady!: (msg: UtilityReadyMessage) => void;
  let rejectReady!: (err: Error) => void;
  const readyPromise = new Promise<UtilityReadyMessage>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  // Parent-death polling (all platforms — poll-based).
  // Linux: should use `prctl(PR_SET_PDEATHSIG, SIGTERM)` at process startup,
  // but that requires a native addon, so the poll path is the cross-platform
  // fallback. Windows could use Job Objects with a native binding instead.
  function startParentPoll() {
    const pollMs = deps.parentPollMs ?? 5000;
    parentPollHandle = deps.setInterval(() => {
      try {
        deps.killProbe(deps.parentPid, 0);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'ESRCH') {
          // Parent is gone — self-exit cleanly.
          void shutdown('parent-died');
          return;
        }
        // Unknown errno (e.g. ENOSYS on an unusual sandbox, EACCES in some
        // container configurations). Log and continue polling so an
        // unexpected kernel signal doesn't silently erase the parent-death
        // defense. Log-only (not self-exit) because false-positive
        // self-exits on a live parent would churn utility processes for no
        // reason.
        console.warn('[utility] parent-poll unexpected errno — continuing', {
          code: code ?? '(missing)',
          parentPid: deps.parentPid,
        });
      }
    }, pollMs);
    parentPollHandle.unref?.();
  }

  function stopParentPoll() {
    parentPollHandle?.clear();
    parentPollHandle = null;
  }

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    stopParentPoll();
    let drainOk = true;
    if (booted) {
      try {
        await booted.destroy();
      } catch (err) {
        // Report via IPC AND exit non-zero. The parent correlates the error
        // IPC with the non-zero exit code; silently exiting 0 on a failed
        // drain hides shutdown failures (stuck watcher, shadow-lock release
        // failure, L2 flush mid-write) and lets them accumulate across
        // restarts. The shutdown-ordering contract explicitly wraps the
        // lock release in try/finally so a mid-shutdown throw still releases
        // — the utility wrapper must not silently convert that throw to exit 0.
        drainOk = false;
        deps.parentPort?.postMessage({
          type: 'error',
          message: `destroy failed during ${reason}: ${(err as Error).message}`,
          stack: (err as Error).stack,
        });
      }
    }
    deps.exit(drainOk ? 0 : 1);
  }

  async function handleInit(msg: UtilityInitMessage) {
    try {
      const server = await deps.importServer();
      const projectDir = msg.opts.projectDir ?? msg.opts.contentDir;
      const prepare = deps.prepareBootEnvironment ?? defaultPrepareBootEnvironment;
      const prepared = await prepare(msg.opts);

      if (env.OK_DEBUG_DESKTOP_BOOT_TRACE === '1') {
        console.warn(
          `[desktop-boot-trace] projectDir=${projectDir} contentRoot=${JSON.stringify(
            prepared.contentRoot,
          )} resolvedContentDir=${prepared.contentDir} configValid=${prepared.configValid}`,
        );
      }

      // Push-permission probe auth seam — Electron has its own boot path
      // distinct from CLI `ok start`'s, so we wire `detectGh` + `tokenStore`
      // here too. Without this, the probe runs anonymously and a signed-in
      // user with push permission on a private repo sees a stale
      // "Sync disabled — you don't have permission" UX because anonymous
      // probe against a private repo returns 404 → `denied/repo-not-found`.
      //
      // Token store is LAZY — the underlying `@napi-rs/keyring` native
      // binding can hang on first load (macOS Keychain prompt, slow
      // binding load), which would block this `await bootServer(...)` and
      // leave the utility's `{ type: 'ready' }` IPC unsent → Electron
      // main waits → user sees a beachball. The lazy wrapper defers init
      // to the first probe call AND time-boxes it (2s, then fall back
      // to file backend). `gh` resolution stays pure-function fast.
      const tokenStore = makeLazyProbeTokenStore();
      // Embeddings key reader for semantic search — reads the CLI's 0600
      // `~/.ok/secrets.yml` file (NOT the Keychain: a keychain read would prompt
      // the user on the agent-triggered search path). Inert until the flag is on
      // + a search opts in.
      const embeddingsKeyStore = makeLazyEmbeddingsKeyStore();

      const bootOpts: BootServerOptions = {
        ...msg.opts,
        contentDir: prepared.contentDir,
        contentRoot: prepared.contentRoot,
        config: prepared.config,
        // Scope-correct exposure consent + admitted-Host source. Passing an
        // explicit serverRuntime is what lets a project-local
        // `server.allowExternal` arm exposure — without it bootServer forces
        // consent off (loopback-only). `bind` mirrors serverRuntime.bind so the
        // exposure interlock's effective-bind check and the ingress policy agree
        // (default loopback for the tunnel case; a committed non-loopback bind
        // then requires the same consent the CLI path demands).
        serverRuntime: prepared.serverRuntime,
        bind: prepared.serverRuntime.bind,
        idleShutdownMs: null, // BrowserWindow lifecycle owns utility lifetime
        skipAutoInit: true,
        autoInitFn: undefined,
        detectGh,
        tokenStore,
        embeddingsKeyStore,
        mcpTomlEditor: getNativeTomlMcpEditor(),
        // ACP threads skip injecting the `open-knowledge` MCP server when the
        // agent's own harness already loads OK's managed editor-config entry
        // (same wiring as `ok start`).
        probeHarnessManagedMcpEntry: (editorId, agentCwd) =>
          probeOwnManagedEditorMcpEntry(editorId, agentCwd),
        // The renderer page origin (Vite dev URL / `file://`) has no asset
        // middleware — serve content assets from this utility server so the
        // renderer can resolve `/<contentDir-relative>` srcs against `apiOrigin`.
        serveContentAssets: true,
        // Serve the bundled React shell on the same HTTP port so external
        // agent in-app browsers (Claude Desktop, Cursor, Codex) can render
        // the same UI the BrowserWindow shows. Resolved by main from the
        // packaged renderer entry path; absent in unusual dev configs.
        ...(msg.opts.reactShellDistDir ? { reactShellDistDir: msg.opts.reactShellDistDir } : {}),
      };

      // Port pinning: a tunnel forwards to a fixed target port, so an ephemeral
      // port would break it on every restart. The scope-resolved `server.port`
      // (project scope) wins; the IPC opt (main passes ephemeral `0`) is the
      // fallback for the unpinned local case.
      //
      // A pinned port can be held by another process (EADDRINUSE). Don't crash
      // or hang the boot — fall back to an ephemeral port so local editing still
      // works. The Remote control pane surfaces the mismatch: it compares the
      // configured `server.port` against the port this window actually bound
      // (read off the bridge apiOrigin), so the user learns the tunnel target no
      // longer matches. bootServer releases its locks and tears down before
      // throwing a listen error, so the ephemeral retry starts from a clean slate.
      const requestedPort = prepared.serverRuntime.port ?? msg.opts.port;
      try {
        booted = await server.bootServer({ ...bootOpts, port: requestedPort });
      } catch (err) {
        if (isFixedPort(requestedPort) && isAddressInUse(err)) {
          console.warn(
            `[boot] pinned server.port ${requestedPort} is already in use — falling back to an ephemeral port`,
          );
          booted = await server.bootServer({ ...bootOpts, port: 0 });
        } else {
          throw err;
        }
      }
      const readyMsg: UtilityReadyMessage = {
        type: 'ready',
        port: booted.port,
        apiOrigin: `http://localhost:${booted.port}`,
      };
      deps.parentPort?.postMessage(readyMsg);
      resolveReady(readyMsg);

      const mergedDegraded: readonly string[] = [
        ...booted.degraded,
        ...(prepared.degradedHints ?? []),
      ];
      if (mergedDegraded.length > 0) {
        deps.parentPort?.postMessage({
          type: 'degraded',
          subsystems: mergedDegraded,
        });
      }
    } catch (err) {
      const errMsg: UtilityErrorMessage = {
        type: 'error',
        message: (err as Error).message,
        stack: (err as Error).stack,
      };
      // Compare on `name` (not instanceof) because `bootServer` is
      // dynamically imported and the class identity may differ across
      // module-realm boundaries.
      const errName = err && typeof err === 'object' ? (err as Error).name : '';
      if (errName === 'ServerLockCollisionError') {
        const existing = (err as { existing?: UtilityErrorMessage['existingLock'] }).existing;
        if (existing) {
          errMsg.kind = 'lock-collision';
          errMsg.existingLock = existing;
        }
      }
      // Git preflight failures get EX_CONFIG (78) so the main process can
      // distinguish them from generic spawn failures. bootServer already
      // emitted telemetry + flushed the exporter; the IPC error carries
      // the install guidance string for the parent to surface if needed.
      const isGitPreflightFailure =
        errName === 'GitNotAvailableError' || errName === 'GitTooOldError';
      deps.parentPort?.postMessage(errMsg);
      rejectReady(err as Error);
      deps.exit(isGitPreflightFailure ? 78 : 1);
    }
  }

  const runSmoke = deps.runSmoke ?? runKeyringSmoke;
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const writeSmokeResult = deps.writeSmokeResult ?? defaultWriteSmokeResult;

  async function handleDebugKeyringSmoke(msg: UtilityDebugKeyringSmokeMessage): Promise<void> {
    const result = await runSmoke();
    deps.parentPort?.postMessage({
      type: 'debug-keyring-smoke-result',
      correlationId: msg.correlationId,
      result,
    });
  }

  function registerMessageListener(): void {
    deps.parentPort?.on('message', (event) => {
      const msg = event.data as UtilityIncomingMessage;
      if (msg?.type === 'init') {
        void handleInit(msg);
      } else if (msg?.type === 'shutdown') {
        void shutdown('shutdown-ipc');
      } else if (msg?.type === 'debug-keyring-smoke') {
        void handleDebugKeyringSmoke(msg);
      }
    });
  }

  async function runBootAutoSmoke(): Promise<void> {
    const result = await runSmoke();
    const outPath = env.OK_DEBUG_KEYRING_SMOKE_OUT;
    if (outPath && outPath.length > 0) {
      try {
        await writeSmokeResult(outPath, `${JSON.stringify(result)}\n`);
      } catch (err) {
        // Non-fatal: log + continue so a permissions failure on the output
        // path doesn't leave the driver hung waiting for an exit that never
        // comes. The driver's missing-output-file branch will surface this
        // on its side.
        console.warn('[utility] auto-smoke write failed', {
          err: (err as Error).message,
          outPath,
        });
      }
    }
    // Observability-only IPC for the dev-mode auto-smoke path — `correlationId:
    // 'auto-boot'` will never match a pending entry in the main-side relay's
    // correlation Map (the renderer doesn't register 'auto-boot' as a pending
    // id), so `handleUtilityMessage` drops it on the floor. We still post it
    // because: the contract mandates the IPC regardless of EXIT mode, an
    // existing test pins the shape, and a future DevTools listener that
    // wants to watch auto-boot results can filter on the sentinel id
    // without a server-entry code change. Under EXIT=1 the post is best-
    // effort fire-and-forget (the process is about to exit); the driver
    // script reads the OUT file, not this IPC.
    deps.parentPort?.postMessage({
      type: 'debug-keyring-smoke-result',
      correlationId: 'auto-boot',
      result,
    });
    if (env.OK_DEBUG_KEYRING_SMOKE_EXIT === '1') {
      deps.exit(0);
      return;
    }
    registerMessageListener();
  }

  // When OK_DEBUG_KEYRING_SMOKE=1 is set, the utility runs the smoke ONCE
  // at boot, BEFORE the `init` message is dispatched. Node.js buffers
  // messages posted to parentPort until a listener is registered, so
  // delaying `registerMessageListener()` until after the smoke completes
  // guarantees the ordering without dropping messages.
  if (env.OK_DEBUG_KEYRING_SMOKE === '1') {
    void runBootAutoSmoke();
  } else {
    registerMessageListener();
  }

  // Signal handlers
  deps.onSignal('SIGTERM', () => void shutdown('SIGTERM'));
  deps.onSignal('SIGINT', () => void shutdown('SIGINT'));

  // Parent-death poll
  startParentPoll();

  return {
    readyPromise,
    stopParentPoll,
    shutdown,
  };
}

/**
 * Default atomic file writer for the smoke output — write to `<path>.tmp`
 * then `rename` to `<path>`, so a reader never sees a partially-written
 * payload. The driver script is the primary consumer.
 */
async function defaultWriteSmokeResult(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, { encoding: 'utf-8' });
  await rename(tmp, path);
}

/** A pinned (fixed) listener port — a positive integer, not the ephemeral `0`/unset. */
function isFixedPort(port: number | undefined): port is number {
  return typeof port === 'number' && port > 0;
}

/** True for a listen error caused by the port already being bound. */
function isAddressInUse(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EADDRINUSE'
  );
}

/**
 * Load the project config scope-correctly (user + committed project +
 * project-local, merged by the shared `loadConfig`) and resolve the effective
 * `server.*` runtime from it.
 *
 * The single, shared `loadConfig` is deliberate: exposure consent
 * (`server.allowExternal`) is a project-local leaf, so a committed value in a
 * cloned repo must never arm it. `loadConfig`'s `mergeLayered` skips the
 * committed layer for project-local leaves — a single implementation the CLI
 * and desktop both call, so the clone-leak guard can't drift between them.
 *
 * `loadConfig` throws only on a schema-invalid merged config; desktop degrades
 * to defaults there (boot on a repairable-in-place file rather than crash),
 * which forces `server.allowExternal` off — the fail-closed direction.
 */
export function resolveDesktopServerRuntime(projectDir: string): {
  config: Config;
  configValid: boolean;
  serverRuntime: ServerRuntimeConfig;
} {
  let config: Config;
  let configValid: boolean;
  try {
    const result = loadConfig(projectDir);
    config = result.config;
    configValid = true;
    // Surface the soft issues the CLI also reports rather than swallowing them:
    // recoverable diagnostics (unknown/removed keys) and any file the loader
    // sidelined to boot on defaults. Hard schema failures throw and are handled
    // in the catch below.
    for (const diag of result.diagnostics) {
      const extra =
        'detail' in diag ? `: ${diag.detail}` : 'path' in diag ? `: ${diag.path.join('.')}` : '';
      console.warn(`[config] ${diag.code}${extra}`);
    }
    for (const { from, to } of result.sidelined) {
      console.warn(
        `[config] ${from} could not be parsed — moved to ${to}; booting on the remaining layers.`,
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[config] desktop boot config invalid — using schema defaults: ${detail}`);
    config = ConfigSchema.parse({});
    configValid = false;
  }
  return { config, configValid, serverRuntime: resolveServerRuntimeConfig(config) };
}

/**
 * Production prelude: ensure-git → scaffold `.ok/` → load config → resolve
 * contentDir. Hits the real filesystem; tests substitute via
 * `SetupUtilityDeps.prepareBootEnvironment`.
 */
async function defaultPrepareBootEnvironment(
  ipcOpts: UtilityInitMessage['opts'],
): Promise<PreparedBootEnvironment> {
  const projectDir = ipcOpts.projectDir ?? ipcOpts.contentDir;

  // ensureProjectGit must run before initContent — initShadowRepo (called
  // transitively from bootServer) creates a shell `.git/` if it runs first.
  // The hardened ensureProjectGit is idempotent on an already-real repo
  // and auto-repairs the shell-`.git/` regression class. Gated so main can
  // run it pre-spawn and signal `didEnsureGit: true` to skip the redundant
  // call.
  const degradedHints: string[] = [];
  if (ipcOpts.didEnsureGit !== true) {
    const result = await ensureProjectGit(projectDir);
    if (result.repaired === true) {
      degradedHints.push('project-git-shell-only');
    }
  }

  // Scaffold `.ok/` synchronously inline. Replaces the previous
  // `bootServer.autoInitFn` indirection so the loaded config is available
  // before bootServer resolves `contentDir`. Idempotent on already-initialized
  // projects (`writeIfMissing` semantics).
  initContent(projectDir);

  // Scope-correct three-layer config load (user + project + project-local),
  // replacing the former project-scope-only read: a project-local
  // `server.allowExternal: true` is now honored while a committed one stays
  // inert, and `bootServer` receives an explicit `serverRuntime` so exposure
  // consent can take effect. On a schema-invalid merged config, fall back to
  // schema defaults rather than crashing the boot.
  const { config, configValid, serverRuntime } = resolveDesktopServerRuntime(projectDir);

  const contentDir = resolveContentDir(projectDir, config, ipcOpts.contentDir);
  const rawContentDir = config.content.dir;
  const contentRoot =
    typeof rawContentDir === 'string' && rawContentDir.length > 0 && rawContentDir !== '.'
      ? rawContentDir
      : undefined;
  return {
    config,
    contentDir,
    contentRoot,
    configValid,
    serverRuntime,
    degradedHints: degradedHints.length > 0 ? degradedHints : undefined,
  };
}

/**
 * Resolve the absolute `contentDir` to pass to `bootServer`, with the loaded
 * project config winning over the IPC fallback when set non-trivially.
 *
 * Defense-in-depth: re-validate the resolved path lives inside `projectDir`.
 * The consent dialog enforces this at admission; this guards against a
 * hand-edited `.ok/config.yml` containing a `..`-escape that the dialog never
 * saw. On escape, fall back to the IPC hint so boot still succeeds with the
 * user-picked folder rather than crashing on a malformed config.
 */
export function resolveContentDir(
  projectDir: string,
  config: Config,
  ipcFallback: string | undefined,
): string {
  const fallback = ipcFallback ?? projectDir;
  const configContentDir = config.content.dir;
  if (
    typeof configContentDir !== 'string' ||
    configContentDir.length === 0 ||
    configContentDir === '.'
  ) {
    return fallback;
  }
  const resolved = isAbsolute(configContentDir)
    ? configContentDir
    : resolve(projectDir, configContentDir);
  const rel = relative(projectDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    console.warn(
      `[config] content.dir=${JSON.stringify(configContentDir)} resolves outside projectDir — using IPC fallback`,
    );
    return fallback;
  }
  return resolved;
}

// Production entry — auto-runs when imported by `utilityProcess.fork(<this-file>)`.
// `process.parentPort` is non-null in utility runtime; tests import the module
// without triggering this branch by checking `process.parentPort` themselves
// (it's null in regular Node).
if ((process as NodeJS.Process & { parentPort?: unknown }).parentPort) {
  setupUtility({
    parentPort: (process as NodeJS.Process & { parentPort: SetupUtilityDeps['parentPort'] })
      .parentPort,
    importServer: () => import('@inkeep/open-knowledge-server'),
    exit: (code) => process.exit(code),
    parentPid: process.ppid,
    killProbe: (pid, signal) => {
      process.kill(pid, signal as NodeJS.Signals | 0);
    },
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    setInterval: (cb, ms) => {
      const handle = setInterval(cb, ms);
      return {
        unref: () => handle.unref(),
        clear: () => clearInterval(handle),
      };
    },
  });
}
