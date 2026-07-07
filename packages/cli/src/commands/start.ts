/**
 * `open-knowledge start` — collab server only (Hocuspocus + /api/*).
 *
 * Lifecycle split:
 * - `ok start` owns the WebSocket (/collab) + HTTP API (/api/*) and advertises
 *   its port via `server.lock`. Static React assets are served by `ok ui`.
 * - On startup we auto-spawn `ok ui` as a detached sibling when `ui.lock` is
 *   absent or stale. A pre-existing live UI is left alone.
 * - Idle-shutdown counts WebSocket upgrades at `/collab` only; it is blind
 *   to DirectConnections by design. When the threshold fires we SIGTERM the
 *   UI sibling before releasing our own lock.
 *
 * The Commander action is a thin wrapper around `bootStartServer` — that
 * boot function returns a `BootedStartServer` handle (`{httpServer, destroy,
 * port, ready, ...}`) so integration tests can drive the same composed boot
 * path the CLI uses, without process-level signal coupling.
 */
import {
  type ChildProcess,
  type spawn as NativeSpawn,
  spawn as nativeSpawn,
} from 'node:child_process';
import { closeSync, existsSync as fsExistsSync, mkdirSync as fsMkdirSync, openSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { basename, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SIGTERM_GRACE_MS as SHARED_DEFAULT_SIGTERM_GRACE_MS,
  DEFAULT_SIGTERM_POLL_MS as SHARED_DEFAULT_SIGTERM_POLL_MS,
  SPAWN_ERROR_LOG,
} from '@inkeep/open-knowledge-core';
import {
  type BootedServer,
  type Config,
  isProjectRoot,
  type PinoLogger,
  prepareSingleFileOpen,
} from '@inkeep/open-knowledge-server';
import { Command, InvalidArgumentError } from 'commander';
import { makeLazyEmbeddingsKeyStore } from '../auth/embeddings-key-store.ts';
import { detectGh } from '../auth/gh-detect.ts';
import { makeLazyProbeTokenStore } from '../auth/token-store.ts';
import { OK_DIR, PACKAGE_VERSION } from '../constants.ts';
import {
  createRealDetectDeps,
  detectDesktop,
  launchDesktop,
  notFoundMessage,
} from './desktop-dispatch.ts';
import { resolveSelfSpawn } from './self-spawn.ts';

/** 30 minutes — default threshold. */
const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Resolve server bind host with `--host` flag > `HOST` env > application
 * default precedence. Pure helper — no side effects, no `process.env` access
 * inside (env passed in) so tests can pin all three branches.
 */
export function resolveHost(
  opts: { host?: string },
  env: { HOST?: string | undefined; [key: string]: string | undefined },
): string {
  return opts.host ?? env.HOST ?? DEFAULT_SERVER_HOST;
}

/** Hard cap on the project-name suffix in `process.title` to keep `ps`/Activity Monitor lines readable. */
const PROCESS_TITLE_PROJECT_NAME_MAX = 64;

/**
 * Derive the `process.title` for a running `ok start` server. The shape is
 * `open-knowledge-server <projectName>` so users can find running servers
 * in Activity Monitor / `ps -ax | grep open-knowledge-server` — the primary
 * surface for orphan management (no in-app stop
 * UX; rely on the OS process list).
 *
 * Sanitization rules (defense-in-depth — `basename(cwd)` is filesystem-
 * controlled, not user-controlled, but a project dir with control bytes
 * or terminal-escape sequences would still corrupt `ps` output):
 *   - Strip everything outside printable ASCII (0x20-0x7E).
 *   - Trim leading/trailing whitespace.
 *   - Truncate to `PROCESS_TITLE_PROJECT_NAME_MAX` chars.
 *   - Fall back to `'unknown'` when the result is empty.
 *
 * Pure function — no `process.title` write, no `process.cwd()` read.
 */
export function deriveServerProcessTitle(cwd: string): string {
  const raw = basename(cwd);
  const sanitized = raw
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, PROCESS_TITLE_PROJECT_NAME_MAX);
  const projectName = sanitized.length > 0 ? sanitized : 'unknown';
  return `open-knowledge-server ${projectName}`;
}

/**
 * Thrown by `bootStartServer` when `.ok/config.yml` is absent — the canonical
 * project-root marker (a bare `.ok/` directory can be a nested folder-rule
 * sidecar, not a project root; see `OK_PROJECT_MARKER` rationale).
 * `runStartCommand` catches this and renders a clean "run ok init first"
 * message — no stack trace.
 */
export class OkDirMissingError extends Error {
  readonly cwd: string;
  constructor(cwd: string) {
    super("This directory isn't set up yet. Run `ok init` first, then `ok start` again.");
    this.name = 'OkDirMissingError';
    this.cwd = cwd;
  }
}

export type UiSpawnDecision =
  | { action: 'spawn'; reason: 'absent' }
  | { action: 'spawn'; reason: 'stale'; stalePid: number }
  | { action: 'skip'; reason: 'alive'; pid: number; port: number };

interface DecideUiSpawnInput {
  uiLock: { pid: number; port: number } | null;
  isAlive: (pid: number) => boolean;
}

/**
 * Pure decision function. The caller feeds the current `ui.lock` contents
 * (or null) and an `isProcessAlive` probe; we return one of three verdicts.
 * No side effects — tests drive it directly without a filesystem.
 */
export function decideUiSpawn(input: DecideUiSpawnInput): UiSpawnDecision {
  if (!input.uiLock) return { action: 'spawn', reason: 'absent' };
  if (!input.isAlive(input.uiLock.pid)) {
    return { action: 'spawn', reason: 'stale', stalePid: input.uiLock.pid };
  }
  return { action: 'skip', reason: 'alive', pid: input.uiLock.pid, port: input.uiLock.port };
}

interface SpawnOkUiOptions {
  lockDir: string;
  cwd: string;
  /** Override for tests — defaults to `node:child_process#spawn`. */
  spawn?: typeof NativeSpawn;
  /** Args to pass after the CLI entry — defaults to `['ui']`. */
  args?: string[];
}

/**
 * Spawn `ok ui` as a detached sibling. Child's stderr is redirected at the
 * kernel layer to `<lockDir>/last-spawn-error.log` — matches the MCP spawn
 * template so the same log consumer can surface failures.
 *
 * Re-execs the current CLI binary rather than shelling out via
 * `npx @inkeep/open-knowledge` to avoid cross-version lockfile-ABI drift and
 * the live-registry-fetch / supply-chain surface. See `self-spawn.ts`.
 *
 * **PORT env hygiene:** the child `ok ui` resolves its bind port via
 * `--port` flag > `PORT` env > default 0 (kernel-allocated) — flag-first,
 * matching `resolveRequestedPort` and the strip note below. When `ok
 * start` itself was invoked with `PORT=<X>` (e.g. operator override), we
 * must NOT inherit that to the child — both processes would try to bind
 * the same port. Stripping `PORT` means the child falls through to its
 * default, which is kernel-allocation — each auto-spawned UI gets a
 * unique port and multi-project concurrency is mechanically true, not just
 * aspirational. If the caller needs a specific UI port, they should invoke
 * `ok ui --port <X>` directly.
 */
export function spawnOkUi(opts: SpawnOkUiOptions): ChildProcess {
  if (!fsExistsSync(opts.lockDir)) fsMkdirSync(opts.lockDir, { recursive: true });
  const stderrPath = join(opts.lockDir, SPAWN_ERROR_LOG);
  const stderrFd = openSync(stderrPath, 'w');
  const spawnFn = opts.spawn ?? nativeSpawn;
  const { PORT: _strippedPort, ...childEnv } = process.env;
  const self = resolveSelfSpawn();
  try {
    const child = spawnFn(self.command, [...self.prefixArgs, ...(opts.args ?? ['ui'])], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      cwd: opts.cwd,
      env: {
        ...childEnv,
        // Under the packaged .app, `self.command` is the Electron helper
        // binary; without this flag it launches as a full Electron app
        // (Dock-tile leak class). node/bun ignore it. Set explicitly so a
        // future env-scrub can't silently drop the inherited value.
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
    child.unref();
    return child;
  } finally {
    // Child now owns the fd — close our copy so the parent does not keep it open.
    try {
      closeSync(stderrFd);
    } catch {
      // Best-effort: some mocks may not hand back a real fd.
    }
  }
}

/**
 * Resolve the collab server's port from the three sources, for `runStartCommand`.
 * An explicit `--port` always wins. Otherwise, when `--ui-port` is set (the
 * worktree-preview recipe) the env `PORT` is the UI sibling's intended port, NOT
 * the collab server's — drop it so the brain kernel-allocates and the two can't
 * contend. Without `--ui-port`, env `PORT` flows through as before. Pure so the
 * suppression rule (the thing that prevents brain/UI port contention) is tested
 * directly.
 */
export function resolveCollabPort(
  portFromCli: number | undefined,
  portFromEnv: number | undefined,
  requestedUiPort: number | undefined,
): number | undefined {
  return portFromCli ?? (requestedUiPort !== undefined ? undefined : portFromEnv);
}

/**
 * Should `ok start` connect to an already-live server instead of booting one?
 * True only on the worktree-preview path (`--ui-port` set) when a live
 * `server.lock` exists for this folder — the main-checkout case, where booting
 * would collide and exit 1. Pure so this safety decision is unit-tested.
 * (`readServerLock` already filters dead/cross-host locks, so a non-null
 * `liveServer` with `port > 0` is a genuinely-live same-host server.)
 */
export function shouldConnectToExistingServer(
  requestedUiPort: number | undefined,
  liveServer: { port: number } | null,
): boolean {
  return requestedUiPort !== undefined && liveServer !== null && liveServer.port > 0;
}

/**
 * Compute `process.exitCode` for the connect-sibling child. A clean numeric exit
 * passes through; a signal death we initiated (a teardown we forwarded) is
 * intentional → 0; an unexpected signal death (external kill) → 1. Pure so both
 * the forwarded-teardown (→0) and external-kill (→1) paths are unit-tested
 * without emitting real process signals.
 */
export function computeConnectExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
  forwardedShutdown: boolean,
): number {
  return code ?? (signal != null && !forwardedShutdown ? 1 : 0);
}

interface ConnectUiSiblingOptions {
  cwd: string;
  /** Port the preview pane passed — the UI sibling is pinned to it. */
  uiPort: number;
  /** Override for tests — defaults to `node:child_process#spawn`. */
  spawn?: typeof NativeSpawn;
}

/**
 * Connect fallback. When `ok start --ui-port P` finds the collab
 * server.lock already held by a live process — the main checkout (server
 * always running), or a lost TOCTOU race against a concurrent start — we must
 * NOT exit 1, because the same committed `launch.json` recipe rides into both
 * the main checkout and every worktree, and a non-zero exit reads to the
 * preview pane as "preview crashed." Instead we "connect": run `ok ui --port P`
 * in this folder, exactly reproducing what the prior bare-`ok ui` recipe did.
 *
 * On main that `ok ui --port P` hits the existing UI's `ui.lock` and enters
 * proxy mode (P → the live UI's real port) — the same path that served main's
 * preview previously. The collab server it advertises via `/api/config` is the
 * already-running one, so the pane connects immediately.
 *
 * The child is foreground-tied (stdio inherited, NOT detached): the pane
 * watches THIS `ok start` process for liveness, so we stay alive until the
 * child exits and forward SIGINT/SIGTERM so the pane's teardown reaches the
 * `ok ui` proxy. Returns when the child exits; `process.exitCode` is the child's
 * numeric exit code, or 0 for a signal death we initiated (forwarded teardown),
 * or 1 for an unexpected signal death (external kill) — so a genuine `ok ui`
 * failure surfaces while normal pane teardown stays clean.
 *
 * `ok ui` honors `--port` over any inherited `PORT` env (`resolveRequestedPort`
 * checks the flag first); we strip `PORT` from the child env anyway to keep the
 * two spawn sites uniform.
 */
export async function connectUiSibling(opts: ConnectUiSiblingOptions): Promise<void> {
  const spawnFn = opts.spawn ?? nativeSpawn;
  const self = resolveSelfSpawn();
  // Strip `PORT` from the child env (mirrors spawnOkUi): we pin the UI port via
  // the explicit `--port` flag, and `ok ui` honors `--port` over `PORT` today —
  // stripping `PORT` keeps the two spawn sites uniform and removes any latent
  // dependence on that flag-vs-env precedence never flipping.
  const { PORT: _strippedPort, ...parentEnv } = process.env;
  const child = spawnFn(self.command, [...self.prefixArgs, 'ui', '--port', String(opts.uiPort)], {
    cwd: opts.cwd,
    stdio: 'inherit',
    env: {
      ...parentEnv,
      // Mirror spawnOkUi: under the packaged .app `self.command` is the
      // Electron helper, which needs this flag to run as plain node rather
      // than launching a full Electron app (Dock-tile leak class).
      ELECTRON_RUN_AS_NODE: '1',
    },
  });

  // Track whether WE forwarded a shutdown signal so the exit handler can tell
  // an intentional teardown from an unexpected external kill.
  let forwardedShutdown = false;
  const forward = (signal: NodeJS.Signals): void => {
    forwardedShutdown = true;
    try {
      child.kill(signal);
    } catch {
      // best-effort — child may already be gone.
    }
  };
  const forwardSigint = () => forward('SIGINT');
  const forwardSigterm = () => forward('SIGTERM');
  process.once('SIGINT', forwardSigint);
  process.once('SIGTERM', forwardSigterm);

  await new Promise<void>((done) => {
    child.on('exit', (code, signal) => {
      // `code` is null when the child was killed by a signal. A signal death we
      // initiated (pane teardown → we forwarded SIGINT/SIGTERM) is intentional →
      // exit 0. A signal death we did NOT initiate (OOM SIGKILL, a concurrent
      // `ok stop`) is unexpected → surface as failure (1) rather than a silent
      // success. A clean numeric exit code passes through verbatim.
      process.exitCode = computeConnectExitCode(code, signal, forwardedShutdown);
      done();
    });
    child.on('error', (err) => {
      console.error(
        `[start] connect fallback: failed to spawn ok ui — ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
      done();
    });
  });

  process.removeListener('SIGINT', forwardSigint);
  process.removeListener('SIGTERM', forwardSigterm);
}

interface AwaitUiSiblingPortInput {
  /** Read the current ui.lock contents. Returns null when absent/stale. */
  readUiLock: () => { port: number } | null;
  /** Virtual clock. Production: `Date.now`. */
  now: () => number;
  /** Sleep between polls. Production: `setTimeout`-based promise. */
  sleep: (ms: number) => Promise<void>;
  /** Abandon the poll after this wall-clock elapses. */
  timeoutMs: number;
  /** Poll interval in ms. */
  pollIntervalMs: number;
}

/**
 * Poll `ui.lock` until the spawned `ok ui` child finishes binding its port
 * (or the timeout expires). Returns the bound port, or `null` on timeout.
 *
 * The child `ok ui` writes an initial lockfile with `port: 0` when it starts
 * (sentinel for "binding"), then calls `updateUiLockPort` with the real
 * kernel-assigned port once `listen()` resolves. Port > 0 is the signal that
 * the sibling is serving requests.
 *
 * Precedent #13b (implicit time-coupling is a test smell): all time + IO deps
 * are injected so `start.test.ts` can drive the loop with a virtual clock
 * without touching the filesystem.
 */
export async function awaitUiSiblingPort(deps: AwaitUiSiblingPortInput): Promise<number | null> {
  const deadline = deps.now() + deps.timeoutMs;
  while (deps.now() < deadline) {
    const lock = deps.readUiLock();
    if (lock && lock.port > 0) return lock.port;
    await deps.sleep(deps.pollIntervalMs);
  }
  // One final read after the last sleep so a lock that appeared within the
  // grace window isn't missed solely because we raced the deadline check.
  const lock = deps.readUiLock();
  if (lock && lock.port > 0) return lock.port;
  return null;
}

interface BuildIdleShutdownHandlerInput {
  readUiLock: () => { pid: number; port: number } | null;
  isAlive: (pid: number) => boolean;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  destroy: () => Promise<void>;
  /** Poll `isAlive(pid)` every this many ms while waiting for SIGTERM to take. */
  sigtermPollIntervalMs?: number;
  /** Abandon SIGTERM and escalate to SIGKILL after this wall-clock elapses. */
  sigtermGraceMs?: number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  log?: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
}

/** 10s grace before SIGKILL escalation — long enough for a healthy UI to
 * release its lock + close sockets; short enough that a wedged UI (GC
 * pause, downstream fetch hang) doesn't stall idle-shutdown indefinitely. */
// Re-export so existing call sites in this file continue to reference the
// constants without an import-name churn. Sourced from the shared core
// module so the CLI's idle-shutdown UI-sibling termination and the
// desktop's `stopAllOwnedServers` use the same numbers.
const DEFAULT_SIGTERM_GRACE_MS = SHARED_DEFAULT_SIGTERM_GRACE_MS;
const DEFAULT_SIGTERM_POLL_MS = SHARED_DEFAULT_SIGTERM_POLL_MS;

/**
 * Build the idle-shutdown `onShutdown` closure. On fire:
 *   (1) look up `ui.lock`; SIGTERM the sibling if it's still alive;
 *   (2) poll its liveness up to `sigtermGraceMs` (default 10s);
 *   (3) if still alive after the grace window, escalate to SIGKILL;
 *   (4) await `destroy()`, which releases `server.lock` as its final step.
 *
 * Escalation matters because a hung `ok ui` (stuck in a GC pause or a
 * downstream fetch in `/api/config`) would otherwise block idle-shutdown
 * indefinitely. Escalation is logged at WARN so the operator sees that a
 * non-standard path ran.
 *
 * Extracted so tests can exercise each branch (no UI, live UI, stale UI,
 * SIGTERM-takes, SIGKILL-escalation) without standing up Hocuspocus.
 */
/**
 * Wrap an idle-shutdown handler so that, after the server is destroyed, the
 * ephemeral session's throwaway temp projectDir is removed. Without this an
 * agent- or tab-closed single-file session leaks its temp dir — boot's destroy
 * alone releases the locks but leaves the dir on disk. Reaping is best-effort
 * (the dir lives in os.tmpdir and is OS-reaped regardless). `rmFn` is injected
 * for testing.
 */
export function withEphemeralTempDirReap(
  handler: () => Promise<void>,
  projectDir: string,
  rmFn: (dir: string) => Promise<void> = (dir) => rm(dir, { recursive: true, force: true }),
): () => Promise<void> {
  return async () => {
    try {
      await handler();
    } finally {
      // `finally` so a throwing handler (e.g. destroy() propagating) still reaps
      // the temp dir rather than leaking it.
      try {
        await rmFn(projectDir);
      } catch (err) {
        // best-effort; the dir is in os.tmpdir (OS-reaped) regardless. rm with
        // force already swallows ENOENT, so anything here (EPERM, bad path) is
        // unexpected — log it so leaked dirs are attributable.
        process.stderr.write(
          `[start] ephemeral temp dir reap failed for ${projectDir}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  };
}

export function buildIdleShutdownHandler(
  input: BuildIdleShutdownHandlerInput,
): () => Promise<void> {
  const graceMs = input.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
  const pollMs = input.sigtermPollIntervalMs ?? DEFAULT_SIGTERM_POLL_MS;
  const sleep = input.sleep ?? ((ms: number) => wait(ms));

  return async () => {
    try {
      const lock = input.readUiLock();
      if (lock && input.isAlive(lock.pid)) {
        try {
          input.killPid(lock.pid, 'SIGTERM');
          input.log?.info({ pid: lock.pid, port: lock.port }, 'idle-shutdown: SIGTERM UI sibling');
          // Wait up to graceMs for the UI process to exit under SIGTERM.
          const deadline = Date.now() + graceMs;
          while (Date.now() < deadline) {
            if (!input.isAlive(lock.pid)) break;
            await sleep(pollMs);
          }
          if (input.isAlive(lock.pid)) {
            // Grace expired — escalate to SIGKILL. Operators see this at WARN.
            try {
              input.killPid(lock.pid, 'SIGKILL');
              input.log?.warn(
                { pid: lock.pid, graceMs },
                'idle-shutdown: SIGTERM grace expired — escalated to SIGKILL',
              );
            } catch (err) {
              input.log?.error(
                { pid: lock.pid, err: err instanceof Error ? err.message : String(err) },
                'idle-shutdown: SIGKILL failed',
              );
            }
          }
        } catch (err) {
          input.log?.warn(
            { pid: lock.pid, err: err instanceof Error ? err.message : String(err) },
            'idle-shutdown: failed to SIGTERM UI sibling',
          );
        }
      }
    } catch (err) {
      input.log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'idle-shutdown: UI lookup failed; proceeding with destroy',
      );
    }
    await input.destroy();
  };
}

interface BootStartServerOptions {
  config: Config;
  cwd: string;
  /**
   * Server bind host. Source ordering at the call site is `--host` flag →
   * `HOST` env → `DEFAULT_SERVER_HOST`. Resolved at the start command,
   * not via config — `server.host` is no longer a schema field.
   */
  host: string;
  /**
   * Server bind port. `server.port` is not a schema field — source ordering
   * at the call site is `--port` flag → `PORT` env → `0` (kernel-allocated).
   * `0` or `undefined` triggers kernel allocation; `bootServer` writes the
   * resolved port into `server.lock` for MCP clients to discover.
   */
  port?: number;
  /**
   * Explicit UI-sibling port. When set, the auto-spawned `ok ui` sibling is
   * pinned to this port (`ok ui --port <uiPort>`) instead of falling through
   * to `DEFAULT_UI_PORT` / kernel-allocation. This is a SEPARATE channel from
   * `PORT` (which `spawnOkUi` strips, to keep the collab server and its UI
   * sibling off the same env-port) so the worktree-preview path can pin the
   * sibling to the port the preview pane passed without that collision.
   * Threaded straight into `spawnOkUi`'s `args` (`['ui','--port',<uiPort>]`)
   * via the existing `opts.args ?? ['ui']` seam — `ok ui` already honors
   * `--port` over the stripped `PORT`, so no `ok ui` change is needed.
   */
  uiPort?: number;
  /**
   * When `true`, bypasses the init-required guard — `bootStartServer` will not
   * throw `OkDirMissingError` even when `.ok/config.yml` is absent. Integration
   * tests that pre-seed `.ok/config.yml` manually should still pass
   * `skipAutoInit: true` to make their intent explicit; tests exercising the
   * no-config rejection should omit this or set it to `false`.
   */
  skipAutoInit?: boolean;
  /** Skip the auto-spawn-of-ok-ui-sibling step entirely (does not call `spawnOkUi`). */
  skipUiAutoSpawn?: boolean;
  /** Override for `spawnOkUi`'s underlying spawn — passed through to it. */
  spawn?: typeof NativeSpawn;
  /** Override idle-shutdown threshold; default 30 min. Tests use small values. */
  idleThresholdMs?: number;
  /**
   * Max wall-clock to wait for the auto-spawned `ok ui` to bind its port
   * (populated via `updateUiLockPort`). Default 3 000 ms — ample for a
   * subprocess to bind on kernel-allocated port 0 + single-socket loopback.
   * On timeout we fall back to the API URL for the banner so the user still
   * sees something actionable.
   */
  uiBindTimeoutMs?: number;
  /**
   * Logger override — defaults to `getLogger('start')`. PinoLogger is
   * already silent in test mode (`NODE_ENV === 'test'` → level: 'silent'),
   * so tests typically don't need to override; this hook exists for any
   * future caller that wants to pipe logs elsewhere.
   */
  log?: PinoLogger;
  /**
   * Injection point for the legacy-MCP-config repair sweep. Tests pass a
   * mock; production omits this and the boot path imports the real
   * `repairMcpConfigs` lazily so the cold-start path is not blocked on
   * editor-config IO that the run may not need.
   */
  repairMcpConfigsFn?: (opts: {
    projectDir: string;
    reclaimDisableEnv: string | null;
    logger?: (event: { event: string }) => void;
  }) => unknown;
  /**
   * Injection point for the legacy-`.claude/launch.json` repair sweep.
   * Sibling of `repairMcpConfigsFn`; tests pass a mock, production omits
   * this and the boot path imports the real `repairLaunchJson` lazily.
   */
  repairLaunchJsonFn?: (opts: {
    projectDir: string;
    reclaimDisableEnv: string | null;
    logger?: (event: { event: string }) => void;
  }) => unknown;
  /**
   * Injection point for the SKILL-file reclaim sweep. Sibling of the two
   * above; tests pass a mock, production omits this and the boot path
   * imports the real `repairSkills` lazily. Async because the user-scope
   * sweep reads `~/.ok/skill-state.yml` + the bundled server package.json
   * before deciding to fan out.
   */
  repairSkillsFn?: (opts: {
    projectDir: string;
    reclaimDisableEnv: string | null;
    logger?: (event: { event: string }) => void;
  }) => Promise<unknown> | unknown;
  /**
   * When `true`, the server serves content-directory assets
   * (images/video/PDF/file attachments) at their `/<contentDir-relative>`
   * paths via `createAssetServeMiddleware` — matching the Vite dev plugin
   * and `ok ui`. Off by default — terminal-launched `ok start` relies on
   * the `ok ui` sibling for asset serving. The OpenKnowledge desktop
   * passes this when spawning the detached server so its renderer can
   * fetch assets from the same origin as `/api/*` and `/collab*`. Forwards
   * directly to `BootServerOptions.serveContentAssets`.
   */
  serveContentAssets?: boolean;
  /**
   * Absolute path to a bundled React shell directory (Vite's `build.outDir`
   * for `@inkeep/open-knowledge-app`). When set, the server serves the
   * shell on `/` (and `/assets/*` etc.) via sirv's SPA fallback, AND the
   * `ok ui` sibling is auto-suppressed (the server is now self-sufficient
   * — no second process required). The desktop passes its bundled shell
   * path so external agent in-app browsers (Claude Desktop, Cursor) can
   * render the UI at the same origin as `/api/*`. Forwards directly to
   * `BootServerOptions.reactShellDistDir`.
   */
  reactShellDistDir?: string;
  /**
   * No-project ephemeral single-file mode (`ok <file>`). Absolute path to the
   * one markdown file to open. When set, `bootStartServer`:
   *   - sets `contentDir = dirname(realpath(singleFile))` (the file's real
   *     parent — where write-back lands, inside contentDir per the
   *     symlink-escape gate) and `singleDocRelPath = basename`;
   *   - uses `projectDir` (the throwaway temp dir holding the synthesized
   *     `.ok/config.yml`) as the project root, NOT cwd;
   *   - boots with `ephemeral: true` + `gitEnabled: false` + MCP unmounted, and
   *     skips the init-required guard and the reclaim sweeps (no project to
   *     reclaim).
   * The caller (`runSingleFileBrowserOpen` / the desktop spawn) owns the temp
   * projectDir's lifecycle and removes it on teardown.
   */
  singleFile?: string;
  /**
   * Explicit project root, distinct from `cwd`. Only meaningful in the
   * ephemeral single-file path, where it is the throwaway temp dir carrying the
   * synthesized `.ok/config.yml`. Defaults to `cwd`.
   */
  projectDir?: string;
}

export interface BootedStartServer {
  /** The bound HTTP server listening on `port`. */
  httpServer: HttpServer;
  /** Composite shutdown — closes httpServer, detaches idle-shutdown, destroys the Hocuspocus server (which releases server.lock). */
  destroy: () => Promise<void>;
  /** Absolute path to `<projectDir>/.ok/local` — runtime-state anchor. */
  lockDir: string;
  /** Resolved content directory (`resolveContentDir(config, cwd)`). */
  contentDir: string;
  /** The kernel-assigned port `httpServer` is bound to (or the config-requested port if non-zero). */
  port: number;
  /** Resolves when async server init (shadow repo, file watcher subscription) completes. */
  ready: Promise<void>;
  /** Subsystems that failed to initialize — read AFTER `ready` for a stable list. */
  degraded: readonly string[];
  /** What we decided about the UI sibling at boot — for tests + status output. */
  uiSpawnDecision: UiSpawnDecision;
  /**
   * The port `ok ui` is actually serving on, resolved end-to-end:
   *   - `action: 'skip'` (sibling already alive) → `uiSpawnDecision.port`
   *   - `action: 'spawn'` and the child bound within `uiBindTimeoutMs` →
   *     the bound port (read from `ui.lock` after `updateUiLockPort`)
   *   - `action: 'spawn'` and the child did not bind in time → `null`
   *   - `skipUiAutoSpawn: true` on the spawn branch → `null`
   *
   * The banner in `startCommand` uses this instead of a hardcoded port so
   * `http://localhost:<port>` always reaches the actually-bound UI. `ok ui`
   * binds `DEFAULT_UI_PORT` when free and falls back to kernel-allocation
   * on collision, so the real port is only knowable after the child binds
   * and writes `ui.lock`.
   */
  resolvedUiPort: number | null;
}

/**
 * Boot the collab server end-to-end and return a handle. Pure of process-level
 * concerns (signal handlers, banner, browser-open, exit codes) so integration
 * tests can drive it directly. The Commander action layers signals + UX on top.
 *
 * The HTTP + WebSocket + listen + lock + idle-shutdown plumbing lives in
 * `@inkeep/open-knowledge-server`'s `bootServer()`; this wrapper adds
 * CLI-specific concerns (init-required guard, resolveContentDir, UI-sibling
 * spawn via `spawnOkUi`, open-browser-on-first-agent-edit).
 */
export async function bootStartServer(opts: BootStartServerOptions): Promise<BootedStartServer> {
  const { config, cwd, host } = opts;
  const skipAutoInit = opts.skipAutoInit ?? false;
  const skipUiAutoSpawn = opts.skipUiAutoSpawn ?? false;
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;

  const { existsSync, mkdirSync } = await import('node:fs');
  const { basename, dirname } = await import('node:path');
  const { bootServer, getLogger, isProcessAlive, readUiLock, resolveContentDir } = await import(
    '@inkeep/open-knowledge-server'
  );

  const log = opts.log ?? getLogger('start');

  // No-project ephemeral single-file mode. The file genuinely lives inside
  // `contentDir` (its real parent), so write-back lands on it through the
  // existing atomic-write spine without tripping the symlink-escape gate; the
  // `.ok/` state lives only in the throwaway `projectDir`. The init-required
  // guard + reclaim sweeps target a real project — neither applies here.
  const ephemeral = opts.singleFile !== undefined;
  const ephemeralProjectDir = opts.projectDir ?? cwd;
  // `--single-file` is the desktop→child spawn contract (the desktop passes a
  // path already validated by `prepareSingleFileOpen`), but the flag is directly
  // reachable. Re-validate to the same typed rejections `ok <file>` gives
  // (markdown ext / exists / is-a-file) rather than booting a degenerate
  // ephemeral server on a directory or non-markdown path. Project detection is
  // the desktop's pre-step, so only the canonical path is taken here.
  const ephemeralFile = ephemeral
    ? prepareSingleFileOpen(opts.singleFile as string).canonicalFilePath
    : undefined;
  const ephemeralContentDir = ephemeralFile ? dirname(ephemeralFile) : undefined;
  const ephemeralDocRelPath = ephemeralFile ? basename(ephemeralFile) : undefined;

  if (!ephemeral) {
    // Guard: cwd must already be a valid OK project root (`.ok/config.yml`
    // exists as a regular file). ok start no longer scaffolds — run `ok init`
    // first. The CLI preAction hook has already anchored cwd to the nearest
    // enclosing project root (see `project-anchor.ts`), so this fires only
    // when no project exists anywhere up the tree — or for direct
    // `bootStartServer` callers that skip the CLI. Guard fires before any
    // filesystem side effects so a rejected start leaves no directory
    // artifacts. Bypassed by skipAutoInit.
    if (!skipAutoInit && !isProjectRoot(cwd)) {
      throw new OkDirMissingError(cwd);
    }

    // `OK_RECLAIM_DISABLE=1` short-circuits all three reclaim sweeps below
    // (MCP configs, launch.json, SKILL files). The env is forwarded into each
    // function so the standalone subcommands (`ok repair-skills`) and the
    // `ok start` boot path share one gate.
    const reclaimDisableEnv = process.env.OK_RECLAIM_DISABLE ?? null;

    // The reclaim sweeps default to writing every step as JSON-lines on stderr.
    // On the interactive `ok start` path that is pure terminal noise ("repaired
    // / skipped X" on every boot), so route the events through the logger and
    // surface only genuine problems: outcomes ending in `-failed` / `-error`
    // (a sweep that errored) or `-missing` (a bundled asset that wasn't found —
    // a degraded install). Routed through `log`, they obey the console level and
    // still land on the file sink. The standalone repair subcommands keep their
    // full JSON stream (they don't pass this logger). Shared across all three
    // sweeps so the whole subsystem is uniformly quiet.
    const reclaimEventLogger = (event: { event: string }) => {
      const name = typeof event.event === 'string' ? event.event : '';
      if (name.endsWith('-failed') || name.endsWith('-error') || name.endsWith('-missing')) {
        log.warn({ event }, '[start] reclaim sweep reported a problem');
      }
    };

    // Sweep MCP host configs forward to today's canonical shape. Catches
    // entries pre-dating the `@latest` pin that npm's engine-aware sort
    // silently downgraded users to. Fail-soft inside `repairMcpConfigs`;
    // wrapped in try/catch as belt-and-braces against the import itself
    // failing (e.g., test environments with mocked module resolution).
    try {
      const repair =
        opts.repairMcpConfigsFn ?? (await import('./repair-mcp-configs.ts')).repairMcpConfigs;
      repair({ projectDir: cwd, reclaimDisableEnv, logger: reclaimEventLogger });
    } catch (err) {
      log.warn({ err }, '[start] mcp-config repair sweep failed; continuing');
    }

    // Sibling sweep for `.claude/launch.json` — same silent-downgrade class
    // as the MCP sweep above. The bare-npx form pre-dating the `@latest`
    // pin would otherwise route Claude Code Desktop's preview-pane spawn
    // through npm's engine-aware sort and silently land on a stale release.
    try {
      const repair =
        opts.repairLaunchJsonFn ?? (await import('./repair-launch-json.ts')).repairLaunchJson;
      repair({ projectDir: cwd, reclaimDisableEnv, logger: reclaimEventLogger });
    } catch (err) {
      log.warn({ err }, '[start] launch.json repair sweep failed; continuing');
    }

    // CLI parity for the desktop's skill-reclaim sweeps: refresh project +
    // user-global SKILL.md files. Async because the user-scope sweep reads
    // the bundled server `package.json` + `~/.ok/skill-state.yml` before
    // deciding whether to fan out. Fail-soft inside `repairSkills`; outer
    // try/catch wraps the import the same way the other two sweeps do.
    try {
      const repair = opts.repairSkillsFn ?? (await import('./repair-skills.ts')).repairSkills;
      await repair({ projectDir: cwd, reclaimDisableEnv, logger: reclaimEventLogger });
    } catch (err) {
      log.warn({ err }, '[start] skill repair sweep failed; continuing');
    }
  }

  // Resolve content directory before bootServer (CLI reads it from Config;
  // bootServer takes a resolved contentDir as input). Ephemeral mode overrides
  // it to the single file's real parent rather than `config.content.dir`.
  const contentDir = ephemeralContentDir ?? resolveContentDir(config, cwd);
  if (!ephemeral && !existsSync(contentDir)) {
    mkdirSync(contentDir, { recursive: true });
    log.info({ contentDir }, 'Created content directory');
  }

  // Capture uiSpawnDecision from inside the spawnUiSiblingFn callback so we
  // can return it on the BootedStartServer handle for tests + status output.
  let uiSpawnDecision: UiSpawnDecision | null = null;
  const spawnUiSiblingFn = async ({
    lockDir: resolvedLockDir,
  }: {
    lockDir: string;
    log: PinoLogger;
  }) => {
    const uiLockBefore = readUiLock(resolvedLockDir);
    uiSpawnDecision = decideUiSpawn({
      uiLock: uiLockBefore,
      isAlive: isProcessAlive,
    });
    if (uiSpawnDecision.action === 'spawn' && !skipUiAutoSpawn) {
      try {
        // Pin the sibling to an explicit `--port` when the caller threaded a
        // UI port (the worktree-preview path passes the preview pane's port).
        // Falls back to the default `['ui']` args otherwise, so terminal
        // `ok start` keeps kernel-allocated sibling ports.
        const uiArgs =
          opts.uiPort !== undefined ? ['ui', '--port', String(opts.uiPort)] : undefined;
        spawnOkUi({ lockDir: resolvedLockDir, cwd, spawn: opts.spawn, args: uiArgs });
        log.info(
          { reason: uiSpawnDecision.reason, uiPort: opts.uiPort },
          '[start] auto-spawned ok ui sibling',
        );
      } catch (err) {
        console.warn(
          `[start] failed to auto-spawn ok ui: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (uiSpawnDecision.action === 'skip') {
      log.info(
        { port: uiSpawnDecision.port, pid: uiSpawnDecision.pid },
        `UI already running at port ${uiSpawnDecision.port}`,
      );
    }
  };

  // When --react-shell-dist-dir is set, the server itself serves the React
  // shell — the `ok ui` sibling is redundant and auto-suppressed. This is
  // the desktop-spawn-mode shape (single-origin renderer); terminal-launched
  // `ok start` keeps the historical two-process model.
  const attachUiSibling = opts.reactShellDistDir === undefined;

  // Push-permission probe auth wiring — LAZY token store. Keyring init is
  // deferred to the first probe call (and time-boxed at 2s with file-backend
  // fallback) so `await bootServer(...)` cannot be blocked by a slow native
  // binding load or a macOS Keychain first-prompt. Flows through `bootServer`
  // → `createServer` → `new SyncEngine` via the structural ProbeTokenStore
  // seam in `github-permissions.ts`. `detectGh` is a pure function — no
  // setup needed, no boot risk.
  const tokenStore = makeLazyProbeTokenStore();
  // Embeddings key reader for semantic search — reads the CLI's 0600
  // `~/.ok/secrets.yml` file (NOT the keychain: a keychain read would prompt the
  // user on the agent-triggered search path). Inert until the feature flag is on
  // AND an agent opts a search into semantic.
  const embeddingsKeyStore = makeLazyEmbeddingsKeyStore();

  const booted: BootedServer = await bootServer({
    config,
    contentDir,
    projectDir: ephemeral ? ephemeralProjectDir : cwd,
    contentRoot: ephemeral ? undefined : config.content.dir,
    port: opts.port,
    host,
    quiet: false,
    detectGh,
    tokenStore,
    embeddingsKeyStore,
    // Ephemeral single-file mode: scope content to the one doc, no MCP, no git
    // (shadow repo + commits off), and a no-op git preflight so a machine
    // without git can still open a loose file. The synthesized config lives at
    // `ephemeralProjectDir/.ok/config.yml`; the file edit lands on the real
    // file inside `contentDir`.
    ...(ephemeral
      ? {
          ephemeral: true as const,
          singleDocRelPath: ephemeralDocRelPath,
          gitEnabled: false as const,
          gitPreflight: () => ({
            ok: true as const,
            version: '0.0.0',
            resolvedPath: 'git',
            source: 'PATH' as const,
          }),
        }
      : {}),
    // Pass the exact runtime that started this server so /api/local-op/* can
    // spawn additional CLI processes without needing open-knowledge on PATH.
    localOpCliArgs: [process.execPath, process.argv[1]],
    // CLI-specific opt-ins
    attachUiSibling,
    idleShutdownMs: idleThresholdMs,
    skipAutoInit: true, // Guard already ran above; no scaffold fn to pass
    ...(attachUiSibling ? { spawnUiSiblingFn } : {}),
    idleShutdownHandler: (destroyServer) => {
      const handler = buildIdleShutdownHandler({
        readUiLock: () => readUiLock(booted.lockDir),
        isAlive: isProcessAlive,
        killPid: (pid, signal) => {
          process.kill(pid, signal);
        },
        destroy: destroyServer,
        log,
      });
      return ephemeral ? withEphemeralTempDirReap(handler, ephemeralProjectDir) : handler;
    },
    log,
    // Single-origin opt-ins for desktop-spawned servers. Forwarded only
    // when set so terminal `ok start` retains today's two-process behavior.
    ...(opts.serveContentAssets ? { serveContentAssets: true } : {}),
    ...(opts.reactShellDistDir ? { reactShellDistDir: opts.reactShellDistDir } : {}),
  });

  // Either `attachUiSibling: false` (this server serves the React shell
  // itself, no sibling needed) or bootServer skipped the callback for
  // some other reason. Sentinel-mark as "skip / no sibling" so the
  // `BootedStartServer` handle is type-complete and the banner falls
  // back to `apiUrl` (which IS the React-shell origin in this mode).
  uiSpawnDecision ||= { action: 'skip', reason: 'alive', pid: 0, port: 0 };

  // Resolve the port `ok ui` is actually serving on — the banner uses this
  // instead of a hardcoded default. `ok ui` binds `DEFAULT_UI_PORT` when
  // free and falls back to kernel-allocation when busy, so the real port
  // is only knowable after the child finishes binding.
  //
  // The `const` snapshot is required — `uiSpawnDecision` is a `let` captured
  // by `spawnUiSiblingFn`'s closure, which defeats TS narrowing across the
  // await boundary.
  const decisionAtBoot: UiSpawnDecision = uiSpawnDecision;
  let resolvedUiPort: number | null = null;
  if (decisionAtBoot.action === 'skip') {
    // Sibling was already alive — the lock already had its port.
    resolvedUiPort = decisionAtBoot.port > 0 ? decisionAtBoot.port : null;
  } else if (!skipUiAutoSpawn) {
    const uiBindTimeoutMs = opts.uiBindTimeoutMs ?? 3000;
    resolvedUiPort = await awaitUiSiblingPort({
      readUiLock: () => readUiLock(booted.lockDir),
      now: Date.now,
      sleep: (ms) => wait(ms),
      timeoutMs: uiBindTimeoutMs,
      pollIntervalMs: 50,
    });
    if (resolvedUiPort === null) {
      log.warn(
        { timeoutMs: uiBindTimeoutMs },
        '[start] ok ui did not bind within timeout — banner falls back to API URL',
      );
    }
  }

  return {
    httpServer: booted.httpServer,
    destroy: booted.destroy,
    lockDir: booted.lockDir,
    contentDir,
    port: booted.port,
    ready: booted.ready,
    degraded: booted.degraded,
    uiSpawnDecision,
    resolvedUiPort,
  };
}

/** Parsed `--mode <browser|app>` option. */
type StartMode = 'browser' | 'app';

interface StartCommandOptions {
  port?: string | number;
  /**
   * From `--ui-port`: pin the auto-spawned `ok ui` sibling to this exact port
   * (the worktree-preview path passes the preview pane's port). Also flips the
   * live-lock collision behavior to "connect" (serve the UI on this port via
   * `ok ui`) instead of exit-1, so the same committed recipe is safe on both
   * the main checkout and a fresh worktree. Absent → today's behavior.
   */
  uiPort?: string | number;
  host?: string;
  open?: boolean;
  /** From `--mode`: undefined (default → browser) | 'browser' | 'app'. */
  mode?: StartMode;
  /** From `--serve-content-assets`. See `BootStartServerOptions.serveContentAssets`. */
  serveContentAssets?: boolean;
  /** From `--react-shell-dist-dir <path>`. See `BootStartServerOptions.reactShellDistDir`. */
  reactShellDistDir?: string;
  /** From `--single-file <path>`. See `BootStartServerOptions.singleFile` — boots
   *  the no-project ephemeral single-file shape (the desktop spawn passes it). */
  singleFile?: string;
  /** From `--project-dir <dir>`. See `BootStartServerOptions.projectDir` — the
   *  throwaway temp project root for the ephemeral single-file shape. */
  projectDir?: string;
}

/**
 * Validator for Commander's `option` parser — restricts `--mode` to the
 * documented enum. Throws `InvalidArgumentError` for anything else,
 * which Commander converts into a non-zero exit + help.
 */
function parseStartMode(value: string): StartMode {
  if (value === 'browser' || value === 'app') return value;
  throw new InvalidArgumentError("--mode must be 'browser' or 'app'");
}

/**
 * Validator for `--ui-port` — rejects non-numeric / out-of-range values at the
 * parent's arg-parse layer (clean `InvalidArgumentError` exit) rather than
 * letting a bad value flow through as `String(NaN)` into the spawned `ok ui`,
 * which would surface as a confusing child spawn failure. Matters more here
 * than for `--port` because `--ui-port` also gates the connect-vs-exit-1 fork.
 */
function parseUiPort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('--ui-port must be a port number between 1 and 65535');
  }
  return port;
}

/**
 * Decide the stdout log level for an interactive `ok start`. The terminal
 * should stay legible — banner + warnings, not a firehose of INFO diagnostics
 * — but those diagnostics must still reach the on-disk file sink for
 * bug-report bundles. Returning 'warn' raises ONLY the pretty stdout stream
 * (see `OK_CONSOLE_LEVEL` in `logger.ts`); the file sink keeps the base level.
 *
 * Returns `null` (leave the env untouched) when the user has already pinned a
 * level explicitly via `OK_CONSOLE_LEVEL` or `LOG_LEVEL` — the discoverable
 * "show me everything" escape hatch (`LOG_LEVEL=info ok start`). Pure so the
 * precedence is unit-tested without booting a server.
 */
export function resolveStartConsoleLevel(env: {
  OK_CONSOLE_LEVEL?: string | undefined;
  LOG_LEVEL?: string | undefined;
}): string | null {
  if (env.OK_CONSOLE_LEVEL !== undefined || env.LOG_LEVEL !== undefined) return null;
  return 'warn';
}

/**
 * Lines shown IMMEDIATELY on shutdown, before the multi-second `destroy()`
 * (which flushes pending writes, commits the shadow repo, and releases the
 * server lock). Pure so the copy + the SIGINT-only force-quit hint are
 * unit-tested without driving real signals. The force-quit hint applies only
 * to SIGINT (the interactive ^C path): `process.once` leaves no SIGINT listener
 * after the first press, so a second ^C hits Node's default disposition
 * (terminate). SIGTERM (from `ok stop` / the system) has no equivalent
 * second-press affordance, so the hint is omitted there.
 */
export function formatShutdownNotice(signal: NodeJS.Signals): string[] {
  const lines = [
    'Stopping OpenKnowledge…',
    'Saving pending changes and releasing the server lock — this can take a few seconds.',
  ];
  if (signal === 'SIGINT') {
    lines.push('Press Ctrl+C again to force quit.');
  }
  return lines;
}

/**
 * Body of the `start` command — exported so `cli.ts`'s no-args dispatch
 * can fall through here without going through Commander a second time.
 * This is the "browser mode" path; bit-for-bit identical to today's
 * behavior when called with no `--mode` or with `--mode=browser`.
 */
export async function runStartCommand(config: Config, opts: StartCommandOptions): Promise<void> {
  // Quiet the terminal BEFORE any getLogger()/reclaim sweep fires (both happen
  // inside bootStartServer below). The `start` logger and the skill-reclaim
  // sweep are constructed before bootServer wires the file sink, so a level
  // threaded through that wiring would miss them — an env read at logger
  // construction time catches every logger uniformly.
  const startConsoleLevel = resolveStartConsoleLevel(process.env);
  if (startConsoleLevel !== null) process.env.OK_CONSOLE_LEVEL = startConsoleLevel;

  const { renderBanner } = await import('../ui/banner.ts');
  const { accent, dim, error, warning } = await import('../ui/colors.ts');

  const cwd = process.cwd();
  const activeConfig = config;

  // Set the process title as early as possible so Activity Monitor and
  // `ps -ax | grep open-knowledge-server` show each running server by
  // project name. This is the primary user-facing surface for orphan
  // management — there's no in-app "Stop server"
  // action; the OS process list is the discovery path.
  process.title = deriveServerProcessTitle(cwd);

  // Source-of-truth host + port resolution: CLI flag > env > application
  // default. Both live as runtime knobs only — neither is a schema field
  // (non-user-configurable either-scope fields are excluded from config).
  const host = resolveHost(opts, process.env as { HOST?: string | undefined });
  const portFromCli = opts.port !== undefined ? Number(opts.port) : undefined;
  const portFromEnv = process.env.PORT ? Number(process.env.PORT) : undefined;
  const requestedUiPort = opts.uiPort !== undefined ? Number(opts.uiPort) : undefined;
  // When `--ui-port` is set, the preview pane's `PORT` env is the UI sibling's
  // intended port, NOT the collab server's — honoring it for the collab port
  // would make the brain and its UI sibling fight over the same port. Ignore
  // env `PORT` for the collab in that case so the brain kernel-allocates; an
  // explicit `--port` still wins if the caller really wants a fixed collab
  // port. (Defense-in-depth: the recipe shell chain also unsets `PORT`.)
  const port = resolveCollabPort(portFromCli, portFromEnv, requestedUiPort);

  // Fast path: when `--ui-port` is set (the worktree-preview recipe), a
  // live collab server already in this folder means we must NOT boot a second
  // one — that's the main checkout, where `ok start` would collide and exit 1.
  // Short-circuit straight to "connect" (serve the UI on the preview's port
  // via `ok ui`, which reuses / proxies the existing UI) so main behaves
  // exactly as the prior bare-`ok ui` recipe did, with no doomed boot attempt.
  // The post-boot catch below is the TOCTOU backstop for the narrow race where
  // a server appears between this check and bootServer's lock acquisition.
  if (requestedUiPort !== undefined) {
    const { readServerLock, resolveLockDir } = await import('@inkeep/open-knowledge-server');
    const liveServer = readServerLock(resolveLockDir(cwd));
    if (shouldConnectToExistingServer(requestedUiPort, liveServer)) {
      await connectUiSibling({ cwd, uiPort: requestedUiPort });
      return;
    }
  }

  let booted: BootedStartServer;
  try {
    booted = await bootStartServer({
      config: activeConfig,
      cwd,
      host,
      port,
      ...(requestedUiPort !== undefined ? { uiPort: requestedUiPort } : {}),
      ...(opts.serveContentAssets ? { serveContentAssets: true } : {}),
      ...(opts.reactShellDistDir ? { reactShellDistDir: opts.reactShellDistDir } : {}),
      ...(opts.singleFile ? { singleFile: opts.singleFile } : {}),
      ...(opts.projectDir ? { projectDir: opts.projectDir } : {}),
    });
  } catch (err) {
    // Project not initialized — clean message, no stack trace.
    if (err instanceof OkDirMissingError) {
      console.error(error(err.message));
      process.exit(1);
    }

    // Git preflight failure: bootServer already emitted telemetry, logged the
    // event, wrote install guidance to stderr, and flushed the OTel exporter
    // before re-throwing the typed error. The CLI just maps it to EX_CONFIG
    // (78), the stable scriptable signal callers can branch on.
    const serverModule = await import('@inkeep/open-knowledge-server');
    if (
      err instanceof serverModule.GitNotAvailableError ||
      err instanceof serverModule.GitTooOldError
    ) {
      process.exit(78);
    }

    // Single-file open target was rejected (missing / not a file / not
    // markdown). The thrown error carries a user-facing one-liner — surface it
    // cleanly instead of a stack trace, matching `ok <file>`'s own handling.
    if (
      err instanceof serverModule.SingleFileNotFoundError ||
      err instanceof serverModule.SingleFileNotAFileError ||
      err instanceof serverModule.SingleFileNotMarkdownError
    ) {
      console.error(error(err.message));
      process.exit(1);
    }

    // TOCTOU backstop: the worktree-preview recipe (`--ui-port` set) lost
    // a race — a server appeared between the fast-path check above and
    // bootServer's lock acquisition (the MCP-shim autostart, or a second
    // preview-open). The boot threw a server-lock collision. Don't exit 1 (that
    // breaks the pane); fall back to connect, exactly like the fast path. Gated
    // on `--ui-port` so plain terminal `ok start` keeps its "already running"
    // message below.
    if (requestedUiPort !== undefined && isServerLockCollision(err, serverModule)) {
      await connectUiSibling({ cwd, uiPort: requestedUiPort });
      return;
    }

    // On server.lock collision, READ the existing lock to give a
    // holder-specific message ("desktop is running on this project")
    // instead of the generic "Failed to start." Failure to read
    // metadata MUST NOT block the original error path — fall back to
    // the generic message in that case.
    const tailored = tryDescribeLockCollision(err, cwd, serverModule);
    if (tailored !== null) {
      console.error(error(tailored));
      process.exit(1);
    }

    console.error(
      `${error('Failed to start:')} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    process.exit(1);
  }

  // Graceful shutdown — idempotent, fires `booted.destroy()` exactly once
  // even if multiple signals arrive (SIGINT then SIGTERM).
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Printed synchronously — BEFORE the async destroy() — so the user gets
    // immediate feedback during the multi-second teardown. Headline bold, the
    // rest dimmed + indented.
    const [headline, ...details] = formatShutdownNotice(signal);
    console.log(accent(`\n${headline}`));
    for (const line of details) {
      console.log(dim(`  ${line}`));
    }
    try {
      await booted.destroy();
    } catch (err) {
      console.error(
        `${error('destroy() failed:')} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  const apiUrl = `http://${host}:${booted.port}`;
  const networkUrl =
    host === '0.0.0.0' || host === '::' ? `http://0.0.0.0:${booted.port}` : undefined;

  // The user-facing URL is the `ok ui` sibling, not the collab/API port.
  // Use `resolvedUiPort` — bootStartServer polls `ui.lock` end-to-end so
  // this reflects the port the child actually bound (kernel-allocated,
  // not a hardcoded default). When the UI sibling did not bind in time
  // (or spawn was skipped) we fall back to the API URL so the user still
  // has an actionable URL.
  const uiPort = booted.resolvedUiPort;
  const localUrl = uiPort !== null && uiPort > 0 ? `http://${host}:${uiPort}` : apiUrl;

  console.log(
    renderBanner({
      name: 'open-knowledge',
      version: PACKAGE_VERSION,
      localUrl,
      apiUrl: localUrl !== apiUrl ? apiUrl : undefined,
      networkUrl,
      nextSteps: ['Open the Editor URL in your browser to start editing.'],
    }),
  );
  // Surface degraded-boot warnings + opt-open after the ready promise resolves.
  const DEGRADED_IMPACTS: Record<string, string> = {
    'shadow-repo': 'Version history and branch-switch safety unavailable',
    'file-watcher': 'External file changes will not sync to the editor',
    'head-watcher': 'Git branch switches may cause document inconsistency',
  };
  booted.ready
    .then(async () => {
      if (booted.degraded.length > 0) {
        console.log();
        for (const id of booted.degraded) {
          const impact = DEGRADED_IMPACTS[id] ?? `${id} (check server logs for details)`;
          console.warn(`  ${warning('\u26a0')} ${warning(id)}: ${dim(impact)}`);
        }
        console.log();
      }

      if (opts.open) {
        const { openBrowser } = await import('../utils/open-browser.ts');
        openBrowser(localUrl);
      }
    })
    .catch((err) => {
      console.error(
        `  ${error('Server initialization failed:')} ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

/**
 * True when `err` is the typed server-lock collision `bootStartServer` throws
 * because a live process already holds this folder's `server.lock`. Used by the
 * connect fallback to distinguish "a server already runs here → connect"
 * from every other boot failure (which still surfaces normally). Defensive on
 * the export shape so a test-mocked server module without the class can't throw
 * here — it just reports `false` and the normal error path runs.
 */
export function isServerLockCollision(
  err: unknown,
  serverModule: typeof import('@inkeep/open-knowledge-server'),
): boolean {
  const lockErr = serverModule.ServerLockCollisionError;
  return lockErr !== undefined && err instanceof lockErr;
}

/**
 * Best-effort tailored message when `bootStartServer` fails because the
 * server.lock is held by another live process. Reads the existing lock
 * metadata and identifies the holder by `kind`. Returns `null` if the
 * error wasn't a lock collision OR if metadata couldn't be read — the
 * caller falls back to the generic message in either case.
 */
export function tryDescribeLockCollision(
  err: unknown,
  cwd: string,
  serverModule: typeof import('@inkeep/open-knowledge-server'),
): string | null {
  const lockErr = serverModule.ServerLockCollisionError;
  if (lockErr === undefined || !(err instanceof lockErr)) return null;

  try {
    const lockDir = join(cwd, OK_DIR);
    const meta = serverModule.readServerLock(lockDir);
    if (!meta) {
      return 'OpenKnowledge server is already running on this project — check `ok status` or `ok stop`.';
    }
    if (meta.kind === 'interactive') {
      return 'OpenKnowledge desktop is currently running on this project. Quit it or use --cwd to point elsewhere.';
    }
    if (meta.kind === 'mcp-spawned') {
      return 'An MCP-spawned server holds this lock; it should release on idle-shutdown (~30 min). Or run `ok stop`.';
    }
    return 'OpenKnowledge server is already running on this project — check `ok status` or `ok stop`.';
  } catch {
    // Generic fallback so a metadata-read failure never escalates the
    // user-visible error path beyond what they'd see today.
    return null;
  }
}

export function startCommand(getConfig: () => Config): Command {
  const cmd = new Command('start')
    .description('Start the knowledge base collab server')
    .option('-p, --port <port>', 'Server port', undefined)
    .option(
      '--ui-port <port>',
      'Pin the ok ui sibling to <port> and connect (not exit) if a server already runs here — the worktree-preview recipe path',
      parseUiPort,
    )
    .option('-H, --host <host>', 'Server host', undefined)
    .option('--open', 'Open browser after start')
    .option('--mode <mode>', "Force dispatch mode: 'browser' or 'app'", parseStartMode)
    .option('--serve-content-assets', 'Serve content assets from this server')
    .option(
      '--react-shell-dist-dir <path>',
      'Serve React shell from <path> (suppresses ok ui sibling)',
    )
    .option(
      '--single-file <path>',
      'No-project ephemeral single-file mode: scope the server to one markdown file (git + MCP off)',
    )
    .option(
      '--project-dir <dir>',
      'Throwaway project root for --single-file (where ephemeral .ok/ state lives)',
    )
    .action(async (opts: StartCommandOptions) => {
      const config = getConfig();

      // `--mode=app` shortcuts the server boot and hands off to the
      // desktop app. Mutually exclusive with --open (which opens a
      // browser tab against the local server, which app mode does not
      // boot).
      if (opts.mode === 'app') {
        if (opts.open) {
          // Don't throw InvalidArgumentError from an async action — Commander
          // catches it on synchronous validators (parser fns) but a thrown
          // error inside the action surfaces as an unhandled rejection with
          // a stack trace. Exit cleanly via process.exit(2) instead, matching
          // Commander's own conventional exit code for argument errors.
          process.stderr.write(
            "error: option '--mode=app' cannot be combined with '--open' (--open opens a browser tab against the local server, which app mode does not boot)\n",
          );
          process.exit(2);
        }

        // Non-mode start flags are silently ignored under --mode=app,
        // with a debug-level diagnostic so a confused user / CI script
        // can grep for it without crashing.
        const ignored: string[] = [];
        if (opts.port !== undefined) ignored.push('--port');
        if (opts.uiPort !== undefined) ignored.push('--ui-port');
        if (opts.host !== undefined) ignored.push('--host');
        if (ignored.length > 0) {
          // Debug-level surface; reuse the existing program log-level
          // gate (--log-level=debug). Inline check to avoid a logger dep.
          const logLevel = process.env.OK_LOG_LEVEL ?? 'info';
          if (logLevel === 'debug' || logLevel === 'trace') {
            console.error(`--mode=app: ignoring ${ignored.join(', ')}`);
          }
        }

        const decision = detectDesktop(createRealDetectDeps());

        if (decision.available) {
          launchDesktop({ spawn: nativeSpawn });
          return;
        }

        // Pass the reason so the user sees a context-appropriate message —
        // "not found" is misleading when the bundle IS detected but the
        // headless gate fired (e.g., SSH on a desktop-installed mac).
        console.error(notFoundMessage(decision.reason));
        process.exit(1);
      }

      // mode === 'browser' or undefined: today's behavior, unchanged.
      await runStartCommand(config, opts);
    });

  return cmd;
}
