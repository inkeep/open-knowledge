/**
 * `bootServer` — HTTP + WebSocket wrapping layer around `createServer()`.
 *
 * Three consumers share this composed boot path:
 *   1. CLI `ok start` (via `bootStartServer` in packages/cli)
 *   2. Electron utility process (direct import — precedent #14-adjacent)
 *   3. Integration tests
 *
 * Before this extraction every consumer reimplemented HTTP + WS upgrade
 * + `listen()` + `updateServerLockPort` + idle-shutdown + composite destroy.
 * The extraction consolidates those ~150 LOC here so all three callers share
 * a single tested orchestrator.
 *
 * Opt-outs (Electron utility uses these):
 *   - `attachUiSibling: false` — suppress UI-sibling spawn flow
 *   - `idleShutdownMs: null` — disable idle-shutdown entirely
 *   - `skipAutoInit: true` — skip the pre-createServer scaffold hook
 *
 * CLI-specific concerns (`initContent`, `spawnOkUi`, banner, signal handlers)
 * are NOT part of bootServer — the CLI wrapper layers them on top via
 * injected callbacks + post-return orchestration.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import {
  ASSET_EXTENSIONS,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
  LOCAL_DIR,
  OK_DIR,
} from '@inkeep/open-knowledge-core';
import {
  resolveGitDir,
  resolveGitDirDetailed,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { context, propagation } from '@opentelemetry/api';
import { simpleGit } from 'simple-git';
import sirv from 'sirv';
import { createAssetServeMiddleware } from './asset-serve-middleware.ts';
import { bootElapsedMs, recordBootPhase, startBootTimings } from './boot-timings.ts';
import type { Config } from './config/schema.ts';
import { ConflictStore } from './conflict-storage.ts';
import { stripDocExtension } from './doc-extensions.ts';
import { normalizeFsPath } from './fs-traced.ts';
import { listNames } from './git-paths.ts';
import {
  assertGitAvailable,
  type GitDetected,
  GitNotAvailableError,
  GitTooOldError,
} from './git-preflight.ts';
import { emitPreflightFailureSpan } from './git-preflight-telemetry.ts';
import { attachIdleShutdown, type IdleShutdownHandle } from './idle-shutdown.ts';
import { resolveLocalSinkConfig } from './local-sink-resolver.ts';
import { getLogger, loggerFactory, type PinoLogger } from './logger.ts';
import { createMcpHttpHandler } from './mcp-http.ts';
import { mountMcpAndApi } from './mcp-mount.ts';
import { MissingOkConfigError } from './missing-ok-config-error.ts';
import { createServer, type ServerInstance, type ServerOptions } from './server-factory.ts';
import { installServerMemoryGauge } from './server-memory-telemetry.ts';
import { reconcileSkillInstalls } from './skill-reconcile.ts';
import { initTelemetry, shutdownTelemetry, withSpan } from './telemetry.ts';
import {
  initToleranceTelemetryWriter,
  teardownToleranceTelemetryWriter,
} from './tolerance-telemetry-writer.ts';
// `ui.lock` is advertisement, NOT mutex. When a process serves the React shell
// for a contentDir, it tries to write `ui.lock` so external consumers (agent
// harnesses opening a preview browser via `preview-url.ts`, MCP tools
// surfacing a clickable URL) can discover the bound port. If a live holder
// already owns the lock — a co-existing `ok ui` sibling, a prior-session
// detached `ok start --react-shell-dist-dir` that survived a desktop quit —
// we YIELD: their port is already reachable and serves the same React shell
// against the same data backend, so the advertisement is already fulfilled.
// Stale locks (dead pid) are pruned automatically by `acquireProcessLock`.
// Only the writer releases on destroy — a desktop quit must not take down a
// peer's advertisement. Ownership is tracked locally via `ownsUiLock` below.
import {
  acquireUiLock,
  markUiLockDraining,
  releaseUiLock,
  UiLockCollisionError,
  updateUiLockPort,
} from './ui-lock.ts';

/**
 * Names of per-machine runtime files that pre-date the `.ok/local/` move.
 * Used by the legacy-files warning at boot start; not a runtime contract.
 */
const LEGACY_RUNTIME_FILENAMES = [
  'server.lock',
  'ui.lock',
  'state.json',
  'principal.json',
  'sync-state.json',
  'conflicts.json',
  'last-spawn-error.log',
] as const;

const LEGACY_RUNTIME_DIRNAMES = ['cache', 'tmp'] as const;

/**
 * Best-effort scan for runtime files left behind at `<okDir>/<name>` by a
 * pre-rename binary. Returns the relative names that are present; appends
 * `/` to dir names for display. Returns empty when `<okDir>/local/` already
 * has any content (the new layout is in use; no warning needed).
 *
 * Exported for unit testing — call sites use it inline at the start of
 * `bootServer()`.
 */
export function findLegacyRuntimeFiles(okDir: string): string[] {
  const localDir = resolve(okDir, LOCAL_DIR);
  const localDirEmpty = (() => {
    if (!existsSync(localDir)) return true;
    try {
      return readdirSync(localDir).length === 0;
    } catch {
      // Inaccessible (perms, race) — treat as empty so the warning still
      // fires if legacy files remain. Boot continues regardless.
      return true;
    }
  })();
  if (!localDirEmpty) return [];

  const found: string[] = [];
  for (const name of LEGACY_RUNTIME_FILENAMES) {
    if (existsSync(resolve(okDir, name))) found.push(name);
  }
  for (const name of LEGACY_RUNTIME_DIRNAMES) {
    const candidate = resolve(okDir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        found.push(`${name}/`);
      }
    } catch {
      // Inaccessible entries don't drive the warning — a stat failure on
      // one candidate must not throw out of a best-effort diagnostic.
    }
  }
  return found;
}

/**
 * Classify the boot project's worktree shape and resolved gitdir for OTel
 * span attributes. `ok.worktree.kind` is bounded enum (`'main' | 'linked'`).
 * `ok.worktree.gitdir` is normalized to last-two-segments via `normalizeFsPath`
 * so the collector's index does not blow up on per-user paths.
 *
 * Cases:
 *   - `.git` is a directory               → `'main'`, gitdir resolved
 *   - `.git` is a parseable pointer file  → `'linked'`, gitdir resolved
 *   - `.git` is a malformed pointer       → `'linked'` (user IS in a worktree;
 *                                            the actionable failure surfaces
 *                                            from the downstream
 *                                            `MalformedGitPointerError`)
 *   - `.git` is inaccessible (`EACCES`)   → `'main'` defensively (we don't
 *                                            know the shape; downstream
 *                                            `GitDirAccessError` surfaces the
 *                                            actionable failure)
 *   - `.git` is absent                    → `'main'` defensively
 */
function computeWorktreeAttributes(projectDir: string): {
  kind: 'main' | 'linked';
  gitdir: string | null;
} {
  const result = resolveGitDirDetailed(projectDir);
  switch (result.kind) {
    case 'directory':
      return { kind: 'main', gitdir: result.path };
    case 'linked':
      return { kind: 'linked', gitdir: result.path };
    case 'malformed-pointer':
      return { kind: 'linked', gitdir: null };
    case 'inaccessible':
    case 'absent':
      return { kind: 'main', gitdir: null };
  }
}

/** 30 minutes — default idle threshold. */
const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;
const DESTROY_STEP_TIMEOUT_MS = 5000;

export interface BootServerOptions
  extends Pick<
    ServerOptions,
    | 'contentDir'
    | 'projectDir'
    | 'contentRoot'
    | 'port'
    | 'host'
    | 'quiet'
    | 'debounce'
    | 'maxDebounce'
    | 'gitEnabled'
    | 'commitDebounceMs'
    | 'wipRef'
    | 'destroyTimeoutMs'
    | 'localOpCliArgs'
    | 'onAgentWrite'
    | 'shadowRepo'
    | 'enableTestRoutes'
    | 'lockKind'
    | 'detectGh'
    | 'tokenStore'
    | 'embeddingsKeyStore'
    | 'singleDocRelPath'
    | 'ephemeral'
  > {
  /**
   * The project's loaded `Config` (parsed from `.ok/config.yml`,
   * with schema defaults applied). Threaded into `createMcpHttpHandler` so
   * MCP tool handlers see the user-configured values (e.g.
   * `config.content.dir`) instead of fabricated defaults.
   */
  config: Config;
  /**
   * If false, `bootServer` does NOT run the pre-createServer `autoInitFn` or
   * invoke UI-sibling spawn logic. Default false.
   */
  skipAutoInit?: boolean;
  /**
   * If false, UI-sibling callbacks (`spawnUiSiblingFn` / `onSkipUiSpawn`) are
   * NOT invoked regardless of `spawnUiSiblingFn` presence. Default true —
   * preserves CLI back-compat when the flag is omitted.
   *
   * Electron utility sets this to `false`: the BrowserWindow IS the UI
   * surface; there is no `ok ui` sibling to spawn.
   */
  attachUiSibling?: boolean;
  /**
   * Idle-shutdown threshold in milliseconds. `null` disables idle-shutdown
   * entirely (Electron utility sets this to `null` — window lifecycle
   * owns utility lifetime). Default 30 * 60 * 1000.
   */
  idleShutdownMs?: number | null;
  /**
   * Serve content-directory assets (images / video / audio / PDF / file
   * attachments) over this HTTP server, mirroring the `bun run dev` Vite
   * plugin and `ok ui`. Default `false`.
   *
   * The Electron utility sets this `true`: the BrowserWindow renderer
   * page origin (a Vite dev URL or a `file://` path) has no asset middleware,
   * so server-absolute `/<contentDir-relative>` image srcs can't resolve
   * there. With this on, the renderer rewrites those srcs onto
   * `window.okDesktop.config.apiOrigin` (the utility server's origin), which
   * serves them via `createAssetServeMiddleware` — the canonical primitive,
   * so the inline/attachment policy + fail-closed 404 guard come for free.
   * The CLI leaves it `false` — `ok ui` already serves content assets on its
   * own port.
   */
  serveContentAssets?: boolean;
  /**
   * Absolute path to the built React shell directory (the bundled SPA — Vite's
   * `build.outDir`, typically `<workspace>/packages/app/dist/`). When set, the
   * boot path mounts a sirv middleware over this directory and threads it
   * through `mountMcpAndApi` as a final fallback (after `/mcp`, `/api/*`, the
   * WS upgrade, and `contentAssetMiddleware`).
   *
   * Used by OK Electron's utility process to serve the bundled React app from
   * its existing HTTP port so external agent in-app browsers (Claude Desktop,
   * Cursor, Codex) can render the live preview at the same URL the lock-based
   * preview resolution returns. The CLI leaves this unset — `ok ui` already
   * serves the shell on its own port. Preserving that two-process split is
   * load-bearing for headless deployments (an `ok start` backend with no UI
   * runs on a server) and for the attach-isolation lock-discovery model
   * (server lifecycle independent of any UI host) — that's the rationale
   * behind the default-off discipline.
   *
   * Sirv is configured with `single: true` (SPA fallback to `index.html`),
   * `gzip: true`, and `immutable: true`. Unlike `ok ui`'s static handler,
   * `extensions: []` is NOT set here: that flag suppresses sirv's
   * directory-index resolution that `single: true` rides on for `/` and
   * bare deep-links. `ok ui` keeps it because its handler shares URL
   * space with `createAssetServeMiddleware` over mixed dist + user
   * content; the React-shell dist served here is isolated (no
   * user-content overlap), so the security guard isn't load-bearing.
   */
  reactShellDistDir?: string;
  /**
   * Pre-createServer scaffolding hook. CLI injects `initContent`; desktop
   * leaves this undefined (no-op). Called only when `skipAutoInit === false`.
   * Returns `true` if any scaffolding occurred during this invocation.
   */
  autoInitFn?: () => boolean | Promise<boolean>;
  /**
   * CLI-specific UI-sibling spawn orchestration. Called once after the server
   * has bound a port IF `attachUiSibling !== false`. Receives `lockDir` so the
   * CLI's spawn helper can read the current ui.lock + decide whether to spawn.
   */
  spawnUiSiblingFn?: (ctx: { lockDir: string; log: PinoLogger }) => void | Promise<void>;
  /**
   * Idle-shutdown handler — run when the server has been idle past the
   * threshold. The CLI passes a handler that SIGTERMs the `ok ui` sibling
   * before calling `destroyServer()`; the desktop utility never wires this
   * handler because `idleShutdownMs: null`.
   */
  idleShutdownHandler?: (destroyServer: () => Promise<void>) => () => Promise<void>;
  /** Injectable logger. Defaults to `getLogger('boot')`. */
  log?: PinoLogger;
  /**
   * Grace period (ms) before keepalive-close triggers session cleanup. Default 30 000.
   * Integration tests pass a small value (e.g. 100) for fast teardown.
   */
  keepaliveGraceMs?: number;
  /**
   * Injectable git-preflight check. Defaults to `assertGitAvailable` from
   * `./git-preflight.ts`. Production callers leave this unset; the integration
   * test for the missing-git path injects a forced-failure preflight (the
   * real CI runners have git installed, so an organic "git absent" failure
   * isn't reproducible without process-level surgery).
   *
   * Mirrors the testability-driven `log` injection above — no production
   * caller passes it, and the field doesn't appear in any public API the
   * subtree publishes externally.
   */
  gitPreflight?: () => GitDetected;
  /**
   * Skip the durable state-manifest pre-flight gate
   * (`assertCompatibleStateManifest`). Default `false`.
   *
   * Production code paths (CLI `ok start`, Electron utility, Vite dev plugin)
   * leave this `false` so an incompatible cold start fails loud before the
   * server touches any shadow-repo state.
   *
   * The integration test harness passes `true` because each test allocates a
   * fresh tmpdir per test (no pre-existing state) and parallel `createServer`
   * invocations against thousands of throwaway content dirs would otherwise
   * spam manifest writes for no benefit. Tests that explicitly exercise the
   * adoption path or version-mismatch behavior leave it `false`.
   */
  skipStateManifestCheck?: boolean;
}

export interface BootedServer {
  /** The bound HTTP server listening on `port`. */
  httpServer: HttpServer;
  /** Composite shutdown — closes httpServer, detaches idle-shutdown, destroys the Hocuspocus server (which releases server.lock). */
  destroy: () => Promise<void>;
  /** Absolute path to `<contentDir>/.ok`. */
  lockDir: string;
  /** Resolved content directory. */
  contentDir: string;
  /** The kernel-assigned port `httpServer` is bound to. */
  port: number;
  /** Resolves when async server init (shadow repo, file watcher subscription) completes. */
  ready: Promise<void>;
  /** Subsystems that failed to initialize — read AFTER `ready` for a stable list. */
  degraded: readonly string[];
  /** `true` if `autoInitFn` scaffolded anything during this boot. */
  didAutoInit: boolean;
  /** Full ServerInstance from createServer — exposed for advanced consumers (e.g., desktop utility's drain sequencing). */
  serverInstance: ServerInstance;
}

/**
 * How many nesting levels of `*.` wildcard segments to enumerate when
 * expanding the credential denylist into Pino redact paths. Pino's redact
 * engine matches one wildcard per segment, so `*.authorization` catches
 * `req.authorization` but NOT `req.headers.authorization`. Five depths
 * cover the dominant HTTP-logging shapes (`req.headers.authorization`,
 * `outer.req.headers.authorization`) and the long tail of framework
 * wrappers without exploding the path array — each denylist entry expands
 * to `1 + DEPTH` redact paths.
 */
const PINO_REDACT_MAX_DEPTH = 5;

/**
 * Boot the collab server end-to-end and return a handle. Pure of process-level
 * concerns (signal handlers, banner, browser-open, exit codes) so the CLI
 * wrapper and Electron utility can each layer their own concerns on top.
 *
 * Git-preflight failure path: on `GitNotAvailableError` / `GitTooOldError`
 * this function emits the failure telemetry span, structured-logs the event,
 * writes the typed error's install guidance to stderr, flushes telemetry, and
 * then re-throws the typed error. Callers decide the exit code (the CLI maps
 * it to EX_CONFIG / 78; the Electron utility surfaces it via IPC). Every
 * other error type propagates unchanged.
 */
export async function bootServer(opts: BootServerOptions): Promise<BootedServer> {
  // Stamp the boot-timing accumulator before anything else so each downstream
  // phase (HTTP listen, the background seed walk + indexes in initAsync) has a
  // monotonic origin to delta against. The module captures both the monotonic
  // origin (for `bootElapsedMs`) and an ISO wall-clock `startedAt` — the latter
  // is what crosses the process boundary on `/api/server-info` for the desktop
  // waterfall's clock-skew math.
  startBootTimings();

  // Resolve telemetry.localSink from project + project-local config BEFORE
  // any getLogger() or withSpan() call so both the logger fileSink and the
  // file SpanExporter compose on the same configured values. The file sink
  // is default-on; only an explicit `telemetry.localSink.enabled: false`
  // disables it. The OTLP push pipeline stays gated by OTEL_SDK_DISABLED.
  //
  // The sink anchors at `projectDir`, NOT `contentDir`: telemetry spans + log
  // files are per-machine runtime state and belong at `<projectDir>/.ok/local/`
  // alongside the server lock / principal / state-manifest. When `content.dir` points at a
  // subdir — or, in single-file mode, contentDir is the user's real directory —
  // anchoring at contentDir would scatter a second `.ok/` into the content tree
  // (and, for single-file mode, violate the zero-artifacts-in-the-user's-dir invariant).
  const sinkProjectDir = opts.projectDir ?? opts.contentDir;
  const localSinkConfig = resolveLocalSinkConfig({
    projectDir: sinkProjectDir,
  });
  if (localSinkConfig) {
    // loggerFactory.configure clears the cached logger map; safe here because
    // bootServer is the entry point and no getLogger() call has fired yet.
    // Mirror the span pipeline's credential scrubbing on the log pipeline by
    // computing Pino redact paths from the same denylist. Pino's redact
    // engine (`@pinojs/redact`) only supports single-segment `*` wildcards
    // — `**` is treated as a literal property name, not a deep wildcard —
    // so each denylist entry expands to the bare key plus one wildcard
    // segment per nesting depth up to PINO_REDACT_MAX_DEPTH. That covers
    // the dominant HTTP-logging shapes (`req.authorization`, depth 1;
    // `req.headers.authorization`, depth 2) and any extra wrapping a
    // framework might add. Censor matches the span sentinel so consumers
    // see one redaction marker everywhere.
    const denylist = localSinkConfig.telemetry.attributeDenylist;
    const redactPaths: string[] = [];
    for (const key of denylist) {
      redactPaths.push(key);
      for (let depth = 1; depth <= PINO_REDACT_MAX_DEPTH; depth++) {
        redactPaths.push(`${'*.'.repeat(depth)}${key}`);
      }
    }
    loggerFactory.configure({
      pinoConfig: { fileSink: localSinkConfig.logs, redactPaths },
    });
  }
  initTelemetry({ localSink: localSinkConfig?.telemetry });
  // Self-gates on OK_BRIDGE_TOLERANCE_TELEMETRY=1; anchored at the same
  // `.ok/local/` runtime-state root as the span/log sinks.
  initToleranceTelemetryWriter(sinkProjectDir);
  installServerMemoryGauge();

  // Wrap the orchestration in an `ok.boot` span so telemetry can slice
  // boot-failure rates by worktree kind. Computed here (not inside
  // `bootServerInner`) because the values are needed for the SpanOptions.
  const { kind: worktreeKind, gitdir: worktreeGitdir } = computeWorktreeAttributes(
    opts.projectDir ?? opts.contentDir,
  );
  const spanAttributes: Record<string, string> = { 'ok.worktree.kind': worktreeKind };
  if (worktreeGitdir !== null) {
    spanAttributes['ok.worktree.gitdir'] = normalizeFsPath(worktreeGitdir);
  }

  // Cross-process trace join (desktop startup instrumentation): when the
  // Electron main process owns the `ok.app-startup` root and spawns this
  // server, it passes its active context as a W3C traceparent in
  // `OK_STARTUP_TRACEPARENT`. Extracting it and running `ok.boot` inside that
  // context parents the server's boot span to the desktop root, so Tempo shows
  // one launch trace spanning main → server → renderer. Absent the env var
  // (CLI `ok start`, tests, push-disabled), `ok.boot` stays a root span exactly
  // as before. The propagator is registered by `initTelemetry` above; when OTel
  // is disabled the extract is a cheap no-op over a no-op tracer.
  const startupTraceparent = process.env.OK_STARTUP_TRACEPARENT;
  const bootSpan = () =>
    withSpan('ok.boot', { attributes: spanAttributes }, async () => bootServerInner(opts));
  if (startupTraceparent) {
    try {
      const parentCtx = propagation.extract(context.active(), { traceparent: startupTraceparent });
      return context.with(parentCtx, bootSpan);
    } catch (err) {
      // A malformed `OK_STARTUP_TRACEPARENT` must never break boot. The
      // registered W3C propagator degrades to an unparented context rather than
      // throwing, so this catch is belt-and-suspenders for a future non-standard
      // propagator — fall through to the unparented boot exactly as the
      // no-env-var path does. Warn so that disconnect is diagnosable: the
      // server's `ok.boot` would otherwise become a detached root in Tempo with
      // nothing in the logs to correlate against the missing join.
      getLogger('boot').warn(
        { err: err instanceof Error ? err.message : String(err) },
        'ok.boot trace-join failed — starting unparented boot',
      );
    }
  }
  return bootSpan();
}

async function bootServerInner(opts: BootServerOptions): Promise<BootedServer> {
  const skipAutoInit = opts.skipAutoInit ?? false;
  const attachUi = opts.attachUiSibling ?? true;
  const idleMsOption = opts.idleShutdownMs;
  const log = opts.log ?? getLogger('boot');

  // Lock-kind resolution. Explicit option wins over env. `OK_LOCK_KIND` is
  // the contract used by the MCP detach-spawn path in
  // `packages/cli/src/mcp/shim.ts` — direct callers (CLI `ok start`,
  // Electron utility) leave it unset. Default `interactive` so
  // omitted-everywhere boots are user-facing servers. Idle-shutdown is the
  // sole teardown trigger; there is no parent-death watch.
  const envLockKind =
    process.env.OK_LOCK_KIND === 'mcp-spawned' || process.env.OK_LOCK_KIND === 'interactive'
      ? process.env.OK_LOCK_KIND
      : undefined;
  const lockKind = opts.lockKind ?? envLockKind ?? 'interactive';

  // Lazy-import node:http so this module can be `import`'d in a browser-like
  // environment for typechecking without pulling network deps at parse time.
  // `ws` (the WebSocket server) is loaded by `mountMcpAndApi` further down.
  const { createServer: createHttpServer } = await import('node:http');
  const { markServerLockDraining, releaseServerLock, updateServerLockPort } = await import(
    './server-lock.ts'
  );

  // Pre-createServer scaffold hook. CLI passes initContent; desktop omits.
  let didAutoInit = false;
  if (!skipAutoInit && opts.autoInitFn) {
    try {
      const initResult = await opts.autoInitFn();
      didAutoInit = Boolean(initResult);
    } catch (err) {
      log.warn({ err }, 'autoInitFn failed');
    }
  }

  // Pre-listen config-presence check. Boot refuses if `.ok/config.yml` is
  // absent (States A and B). When only `.ok/.gitignore` is missing (State C)
  // we emit a per-boot hygiene warning (one stderr line per bootServer
  // invocation; not deduplicated across restarts) and proceed — boot does
  // not read .gitignore, so refusing on its absence would be the only place
  // this code enforces git hygiene as a hard gate.
  //
  // The check resolves against `projectDir`, NOT `contentDir`. Config canonically
  // lives at `<projectDir>/.ok/config.yml` (loader.ts), regardless of where
  // `content.dir` points. When `content.dir` is set non-trivially (e.g. `docs`),
  // `contentDir = <projectDir>/docs` while config still lives at `<projectDir>/.ok/`.
  // Falling back to `contentDir` preserves existing behavior for callers that
  // omit `projectDir` (they must mean the two are the same).
  const projectDir = opts.projectDir ?? opts.contentDir;
  const okDir = resolve(projectDir, OK_DIR);
  const configPath = resolve(okDir, 'config.yml');
  if (!existsSync(configPath)) {
    const okDirExists = existsSync(okDir);
    throw new MissingOkConfigError(okDirExists ? 'config' : 'okdir', projectDir);
  }
  const gitignorePath = resolve(okDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    console.warn(
      `[boot] Note: ${OK_DIR}/.gitignore is missing — per-machine state files in ${OK_DIR}/ may show up as untracked changes. Run \`ok init\` to add the recommended ignore entries.`,
    );
  }

  // Git binary preflight. simple-git's failure mode for a missing/old git is
  // a raw `Error: spawn git ENOENT` (or similar) bubbling up from whichever
  // call site happens to fire first — typically deep in createServer's
  // shadow-repo init. Detecting it here turns that into a typed error with
  // platform-aware install guidance + a stable exit code.
  //
  // Skipped when git is disabled (the no-project ephemeral single-file shape,
  // `gitEnabled: false`): that server never invokes git, so requiring the binary
  // would block opening a loose file for a user without git — the zero-setup case
  // the mode exists to serve.
  const preflight = opts.gitPreflight ?? assertGitAvailable;
  try {
    if (opts.gitEnabled !== false) preflight();
  } catch (err) {
    if (err instanceof GitNotAvailableError || err instanceof GitTooOldError) {
      const detectedVersion = err instanceof GitTooOldError ? err.detected : '';
      const reason = err instanceof GitTooOldError ? 'too_old' : 'not_available';
      // Failure-only telemetry. Bounded cardinality enforced by
      // `emitPreflightFailureSpan`; no-op when OTEL is disabled.
      emitPreflightFailureSpan(err);
      log.warn(
        {
          event: 'git_preflight_fail',
          platform: err.platform,
          reason,
          detectedVersion,
        },
        reason === 'not_available' ? 'git binary not found' : 'git binary too old',
      );
      process.stderr.write(`${err.message}\n`);
    }
    // Flush pending telemetry before re-throwing — applies to BOTH the typed
    // preflight-failure branch above AND any non-typed error (programmer
    // error, OOM, `spawnSync` permission error) that fell through to the
    // catch-all path. `initTelemetry()` ran unconditionally at the top of
    // `bootServer`, so the BatchSpanProcessor buffer holds spans either way;
    // if the caller calls `process.exit()` on receiving the throw, the buffer
    // is discarded and any emitted span never reaches the exporter.
    // `shutdownTelemetry` is idempotent and bounded by its own 5s timeout,
    // so a stuck exporter cannot indefinitely block the caller. The tolerance
    // writer's drain has no internal deadline (a stalled writeFile/rename on
    // an unresponsive mount would hold this error path open and keep the CLI
    // from reaching its exit code), so cap it here to match — the normal
    // destroy path gets the same bound via `runStep`.
    await shutdownTelemetry();
    await Promise.race([
      teardownToleranceTelemetryWriter(),
      new Promise<void>((resolve) => setTimeout(resolve, DESTROY_STEP_TIMEOUT_MS)),
    ]);
    throw err;
  }

  // Per-machine runtime files moved from `.ok/<name>` to `.ok/local/<name>`.
  // Warn once if a project still has the legacy layout AND `.ok/local/` is
  // empty/missing — the new code reads/writes only under `.ok/local/`, so
  // legacy files at the root sit inert until the developer cleans them up.
  // No action taken; boot proceeds.
  const legacyFound = findLegacyRuntimeFiles(okDir);
  if (legacyFound.length > 0) {
    console.warn(
      `[boot] Found legacy runtime files at ${OK_DIR}/${legacyFound.join(', ')}. Delete ${OK_DIR}/ and re-init — these files moved to ${OK_DIR}/${LOCAL_DIR}/.`,
    );
  }

  // Compose createServer options from the subset we accept.
  const serverInstance = createServer({
    contentDir: opts.contentDir,
    projectDir: opts.projectDir,
    contentRoot: opts.contentRoot,
    port: opts.port,
    host: opts.host,
    quiet: opts.quiet ?? false,
    debounce: opts.debounce,
    maxDebounce: opts.maxDebounce,
    gitEnabled: opts.gitEnabled,
    commitDebounceMs: opts.commitDebounceMs,
    wipRef: opts.wipRef,
    enableTestRoutes: opts.enableTestRoutes,
    shadowRepo: opts.shadowRepo,
    destroyTimeoutMs: opts.destroyTimeoutMs,
    localOpCliArgs: opts.localOpCliArgs,
    onAgentWrite: opts.onAgentWrite,
    lockKind,
    skipStateManifestCheck: opts.skipStateManifestCheck,
    detectGh: opts.detectGh,
    tokenStore: opts.tokenStore,
    embeddingsKeyStore: opts.embeddingsKeyStore,
    singleDocRelPath: opts.singleDocRelPath,
    ephemeral: opts.ephemeral,
  });

  const {
    hocuspocus,
    destroy: destroyHocuspocus,
    ready,
    degraded,
    lockDir,
    sessionManager,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    maintenanceCoordinator,
  } = serverInstance;

  const mcpHost = (() => {
    const host = opts.host ?? 'localhost';
    if (host === '0.0.0.0' || host === '::') return 'localhost';
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  })();
  let boundPort = opts.port ?? 0;
  // No-project ephemeral single-file mode mounts NO MCP endpoint:
  // there are no agent capabilities. `mountMcpAndApi` leaves `/mcp`
  // unmounted when `mcpHttpHandler` is undefined, so an undefined handler is
  // the structural off-switch — no `/mcp` route exists to reach.
  const mcpHttpHandler = opts.ephemeral
    ? undefined
    : createMcpHttpHandler({
        contentDir: opts.contentDir,
        projectDir: opts.projectDir ?? opts.contentDir,
        config: opts.config,
        getServerUrl: () => `http://${mcpHost}:${boundPort}`,
        log,
      });

  // HTTP server — `mountMcpAndApi` installs the `/mcp` + `/api/*` request
  // routing and the `/collab` + `/collab/keepalive` upgrade handler. Static
  // React assets are served separately by `ok ui` (a CLI wrapper concern, not
  // modeled here).
  const httpServer = createHttpServer();
  // Resource-exhaustion bounds (defense-in-depth): cap headers + full
  // request lifetimes so a slow client cannot dribble bytes below the 1 MB
  // body cap in `request-validation.ts` and hold a handler's async slot
  // indefinitely. `MAX_BODY_BYTES = 1 MB` finishes well under 30s on any
  // realistic network, so 30s headers + 60s request-total is safe for
  // legitimate clients while keeping slowloris-class abuse bounded. Node
  // ships sane defaults (60s headers, 5 min request) but we pin both
  // explicitly so the bound is part of the contract, not a runtime default
  // that could shift across Node majors.
  httpServer.headersTimeout = 30_000;
  httpServer.requestTimeout = 60_000;

  // Content-asset serving — desktop mode only. Reuses the canonical
  // `createAssetServeMiddleware` (STOP rule: serve-side asset admission goes
  // through this factory) so the inline/attachment Content-Disposition policy
  // + fail-closed 404 guard match the Vite dev plugin and `ok ui`.
  const contentAssetMiddleware = opts.serveContentAssets
    ? createAssetServeMiddleware({
        contentFilter: serverInstance.contentFilter,
        contentSirv: sirv(opts.contentDir, { dev: true, dotfiles: false }),
        inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
        assetExtensions: ASSET_EXTENSIONS,
        blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
      })
    : undefined;

  // When serving the React shell, try to advertise via `ui.lock` so external
  // preview-URL consumers find our port. If a live holder already owns the
  // lock (a co-existing `ok ui` sibling, a prior-session orphan), we yield
  // and proceed without owning the lock — their port already satisfies the
  // discovery contract. Stale-lock pruning is automatic inside
  // `acquireProcessLock`; we only catch the live-collision case here.
  let ownsUiLock = false;
  if (opts.reactShellDistDir) {
    try {
      acquireUiLock(lockDir, {
        port: 0,
        worktreeRoot: opts.projectDir ?? opts.contentDir,
      });
      ownsUiLock = true;
    } catch (err) {
      if (err instanceof UiLockCollisionError) {
        // Co-exist with the live holder. Their advertisement is sufficient
        // for agent harness preview-browser flows. Logged at info so
        // operators can grep for the yield in the wild without confusion.
        // `pid` is THIS server's pid (the yielder); `existingPid` is the
        // peer holding the lock — operators need both for incident
        // correlation when one of them later misbehaves.
        log.info(
          {
            event: 'ui-lock-yielded-to-live-holder',
            pid: process.pid,
            existingPid: err.existing.pid,
            existingPort: err.existing.port,
            lockDir,
          },
          'ui.lock already held by a live process — yielding (advertisement is fulfilled)',
        );
      } else {
        // Any other failure (filesystem, permissions, corrupt-and-unrecoverable
        // lock) — surface it; the React shell would still serve, but losing
        // the discovery channel silently is the worse failure mode.
        await destroyHocuspocus().catch(() => {
          /* best-effort — surface the original error */
        });
        // Boot failed but this process may keep living (Electron utility
        // surfaces the error over IPC). destroyHocuspocus defers its unlink
        // to process exit, which would strand a live-pid draining lock that
        // blocks every future start — release it for real here.
        releaseServerLock(lockDir);
        throw err;
      }
    }
  }

  // React-shell serving — Electron utility opt-in.
  //   - `single: true` — SPA fallback to `index.html` for unknown routes
  //   - `gzip: true` + `immutable: true` — standard hashed-asset perf flags
  // Mounted in `mountMcpAndApi` AFTER `/mcp`, `/api/*`, the WS upgrade, and
  // `contentAssetMiddleware` — so existing surfaces keep priority and the
  // React shell is purely a fallback for non-data routes.
  //
  // Note: unlike `ok ui`'s shell handler, this middleware does NOT pass
  // `extensions: []`. That guard exists in `ok ui` because its static
  // handler shares URL space with `createAssetServeMiddleware` over a
  // mixed dist + user-content layout — without it, `/foo` could
  // transparently resolve `foo.html` and bypass Content-Disposition
  // policy. Here the React-shell dist is isolated (no user-content
  // overlap) and we want sirv's default `single: true` SPA-fallback
  // behavior to work for unknown routes, which `extensions: []`
  // suppresses (it disables sirv's directory-index resolution path
  // that `single: true` rides on for `/` and bare deep-links).
  const reactShellMiddleware = opts.reactShellDistDir
    ? sirv(opts.reactShellDistDir, {
        single: true,
        gzip: true,
        immutable: true,
      })
    : undefined;

  const mount = mountMcpAndApi({
    httpServer,
    hocuspocus,
    mcpHttpHandler,
    log,
    sessionManager,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    maintenanceCoordinator,
    keepaliveGraceMs: opts.keepaliveGraceMs,
    contentAssetMiddleware,
    reactShellMiddleware,
    ephemeral: opts.ephemeral,
  });

  // Forward-declare destroy so idle-shutdown's onShutdown can reach the full
  // teardown sequence (httpServer.close + telemetry + everything) rather than
  // just destroyHocuspocus(). Without this hoist the only callable in scope is
  // destroyHocuspocus, which releases the Hocuspocus layer + server.lock but
  // leaves the http.Server LISTEN socket bound — so once the 30-min timer
  // fired and `fired=true` latched, the process kept running indefinitely with
  // an idle listener and no path back to shutdown. See `attachIdleShutdown`
  // for the `fired` latch behavior.
  //
  // Sentinel-initialized rather than left uninitialized: the timer cannot fire
  // before `httpServer.listen` resolves (the `scheduleShutdown` call inside
  // `attachIdleShutdown` only schedules a timer; nothing pumps it until the
  // event loop returns to libuv), and `destroy` is assigned synchronously
  // before that listen resolves. But if something ever does call this before
  // the real assignment, a clear error beats a "Cannot access 'destroy' before
  // initialization" TDZ trace.
  let destroy: () => Promise<void> = async () => {
    throw new Error('bootServer: destroy() invoked before initialization — boot did not complete');
  };

  // Idle-shutdown wiring — suppressed entirely when idleShutdownMs is null.
  // The CLI uses this to tear down both its own server and the `ok ui` sibling
  // after 30 min of zero WS clients; the Electron utility disables it because
  // window-close IS the shutdown trigger.
  let idleHandle: IdleShutdownHandle | null = null;
  if (idleMsOption !== null) {
    const idleMs = idleMsOption ?? DEFAULT_IDLE_THRESHOLD_MS;
    const idleHandler =
      opts.idleShutdownHandler ??
      ((destroyFn) => async () => {
        await destroyFn();
      });
    idleHandle = attachIdleShutdown({
      httpServer,
      thresholdMs: idleMs,
      log,
      onShutdown: idleHandler(async () => {
        await destroy();
      }),
    });
  }

  // Eagerly restore `lifecycle.status='conflict'` for any docs tracked in
  // `.ok/local/conflicts.json` before HTTP/MCP starts accepting requests.
  // Closes the server-restart race where the in-memory lifecycle map was
  // lost on shutdown and the file-watcher cannot re-emit because mtime
  // didn't change. Errors are swallowed (warn-log + continue) so a missing
  // or malformed `conflicts.json` never blocks boot.
  await restoreLifecycleFromConflictsJson({
    hocuspocus,
    projectDir: opts.projectDir ?? opts.contentDir,
    log,
  });

  // Listen — resolves only after the kernel has bound the port so callers
  // can probe `port` immediately.
  try {
    await new Promise<void>((resolveListen, reject) => {
      const onError = (err: Error) => reject(err);
      httpServer.once('error', onError);
      httpServer.listen(opts.port, opts.host, () => {
        httpServer.removeListener('error', onError);
        resolveListen();
      });
    });
  } catch (err) {
    // Listen failed after locks were acquired. Release ui.lock only if we
    // own it (we yielded to a live holder, that holder keeps advertising);
    // destroyHocuspocus releases server.lock either way.
    if (ownsUiLock) {
      try {
        releaseUiLock(lockDir);
      } catch (releaseErr) {
        log.warn({ err: releaseErr }, 'releaseUiLock failed during listen-error cleanup');
      }
    }
    await destroyHocuspocus().catch(() => {
      /* best-effort — surface the original listen error */
    });
    // Same rationale as the ui.lock error path above: the process may keep
    // living after a failed boot, so the deferred-to-exit unlink would strand
    // a live-pid draining lock. Release immediately on this error path.
    releaseServerLock(lockDir);
    throw err;
  }

  // Boot is usable for HTTP from here; record the listen latency. The
  // background `initAsync` (seed walk + indexes) still runs and feeds the
  // remaining boot-timing fields before `ready` resolves.
  const listenMs = bootElapsedMs();
  if (listenMs !== undefined) recordBootPhase('httpListenMs', listenMs);

  const addr = httpServer.address();
  const realPort = typeof addr === 'object' && addr !== null ? addr.port : (opts.port ?? 0);
  boundPort = realPort;
  updateServerLockPort(lockDir, realPort);
  if (ownsUiLock) {
    // Flip the sentinel port=0 to the bound port so preview-URL consumers see
    // a reachable URL. Only writes if we still own the lock (paranoia in
    // case an out-of-band release happened between acquire and listen).
    updateUiLockPort(lockDir, realPort);
  }

  // UI-sibling spawn — CLI wrapper injects `spawnUiSiblingFn`; desktop leaves
  // `attachUiSibling: false` and this flow is suppressed.
  if (attachUi && opts.spawnUiSiblingFn) {
    try {
      await opts.spawnUiSiblingFn({ lockDir, log });
    } catch (err) {
      log.warn({ err }, 'spawnUiSiblingFn failed');
    }
  }

  let destroyed = false;
  const withDestroyTimeout = async (name: string, work: () => Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${name} timed out after ${DESTROY_STEP_TIMEOUT_MS}ms`));
          }, DESTROY_STEP_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  destroy = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    const errors: unknown[] = [];
    const runStep = async (name: string, work: () => Promise<void>): Promise<void> => {
      try {
        await withDestroyTimeout(name, work);
      } catch (err) {
        errors.push(err);
        log.warn({ err, step: name }, 'bootServer destroy step failed');
      }
    };

    // Advertise teardown before the first close step so discovery and
    // supervisors stop treating this server as dialable the moment shutdown
    // begins — not seconds later when the Hocuspocus destroy reaches its own
    // draining mark. Idempotent with the mark inside `destroyHocuspocus`.
    try {
      markServerLockDraining(lockDir);
      if (ownsUiLock) markUiLockDraining(lockDir);
    } catch (err) {
      log.warn({ err, step: 'markLocksDraining' }, 'bootServer destroy step failed');
    }

    try {
      idleHandle?.detach();
    } catch (err) {
      errors.push(err);
      log.warn({ err, step: 'idleHandle.detach' }, 'bootServer destroy step failed');
    }

    await runStep('mount.shutdown', () => mount.shutdown());
    if (mcpHttpHandler !== undefined) {
      await runStep('mcpHttpHandler.close', () => mcpHttpHandler.close());
    }
    await runStep(
      'mount.wss.close',
      () =>
        new Promise<void>((resolveClose, rejectClose) => {
          mount.wss.close((err) => (err ? rejectClose(err) : resolveClose()));
        }),
    );
    await runStep('httpServer.closeAllConnections', async () => {
      httpServer.closeAllConnections?.();
    });
    await runStep(
      'httpServer.close',
      () =>
        new Promise<void>((resolveClose, rejectClose) => {
          httpServer.close((err) =>
            err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
              ? rejectClose(err)
              : resolveClose(),
          );
        }),
    );
    await runStep('destroyHocuspocus', () => destroyHocuspocus());
    if (ownsUiLock) {
      // Release ONLY if we own it. If we yielded at boot to a live holder,
      // that holder's advertisement must survive our destroy — taking down
      // ui.lock on quit-without-ownership would silently break their
      // preview-URL discovery. Unlink deferred to process exit for the same
      // reason as server.lock: lock-gone must mean process-gone.
      await runStep('releaseUiLock', async () =>
        releaseUiLock(lockDir, { deferUnlinkToExit: true }),
      );
    }
    // Flush pending spans/metrics so the teardown sequence itself is
    // observable. shutdownTelemetry is idempotent and has its own timeout.
    await runStep('shutdownTelemetry', () => shutdownTelemetry());
    // Unhook + drain the tolerance-telemetry JSONL appender so fires from
    // the destroy steps above land on disk (no-op when the flag is off).
    await runStep('teardownToleranceTelemetry', () => teardownToleranceTelemetryWriter());
    // Drain Pino file-sink writes LAST so log records emitted during the
    // prior destroy steps (including shutdownTelemetry's own warnings) land
    // on disk before the caller's process.exit(). Pino's built-in flush is
    // sync and only addresses sonic-boom; the file sink writes through an
    // async RotatingAppender chain that needs an explicit drain. No-op when
    // the local sink is disabled.
    await runStep('flushLogFileSinks', () => loggerFactory.flushAllFileSinks());

    if (errors.length > 0) {
      throw new AggregateError(errors, 'bootServer destroy completed with errors');
    }
  };

  // Reconcile on open (best-effort, non-fatal): bring editor skill dirs into
  // line with the symlink model — heal drifted/broken links, adopt foreign or
  // legacy-copy skills into `.ok/skills` and symlink them, drop orphan links.
  // One hook covers CLI `ok start`, desktop, and dev. The shipped bundle sweep
  // (no-create, copy) owns OK's own bundle.
  try {
    const r = await reconcileSkillInstalls({
      projectDir,
      skillsRoot: resolve(opts.contentDir, OK_DIR, 'skills'),
    });
    const changed =
      r.healed.length +
      r.adopted.length +
      r.replaced.length +
      r.collided.length +
      r.orphansRemoved.length;
    if (changed > 0) {
      log.info?.(
        {
          event: 'installed-skills-reconciled',
          healed: r.healed.length,
          adopted: r.adopted.length,
          replaced: r.replaced.length,
          collided: r.collided.length,
          orphansRemoved: r.orphansRemoved.length,
        },
        `Reconciled ${changed} editor skill entr${changed === 1 ? 'y' : 'ies'} to the symlink model.`,
      );
    }
  } catch (err) {
    log.warn?.(
      { event: 'installed-skills-reconcile-failed', error: String(err) },
      'Installed-skills reconcile failed (non-fatal).',
    );
  }

  return {
    httpServer,
    destroy,
    lockDir,
    contentDir: opts.contentDir,
    port: realPort,
    ready,
    degraded,
    didAutoInit,
    serverInstance,
  };
}

/**
 * Read `.ok/local/conflicts.json` and pre-seed `lifecycle.status =
 * 'conflict'` on every tracked doc's Y.Map before HTTP/MCP starts accepting
 * requests. Without this restoration, a server restart while a conflict is
 * outstanding loses the in-memory lifecycle gate; the file-watcher cannot
 * re-emit the conflict because the marker-laden file's mtime is unchanged;
 * the next mutating write reaches the doc unguarded.
 *
 * Failure mode is best-effort: a missing or malformed `conflicts.json` must
 * not block boot. The structural defense is at-write gating in the
 * mutating-handler spines, not this restoration; if the restore degrades,
 * the next file-watcher event still recovers correct state.
 *
 * Emits a structured `lifecycle-restored-from-conflicts-json` event per
 * restored doc so adoption can be tracked from logs.
 */
export async function restoreLifecycleFromConflictsJson(args: {
  hocuspocus: ServerInstance['hocuspocus'];
  projectDir: string;
  log: PinoLogger;
}): Promise<void> {
  const { hocuspocus, projectDir, log } = args;
  let store: ConflictStore;
  let entries: Array<{ file: string }>;
  try {
    store = new ConflictStore(projectDir);
    entries = store.list();
  } catch (err) {
    log.warn(
      { err, projectDir },
      '[boot] lifecycle restore: failed to read conflicts.json — skipping',
    );
    return;
  }
  if (entries.length === 0) return;

  // Reconcile against git's source of truth BEFORE seeding lifecycle Y.Maps.
  // The user may have resolved a conflict externally (CLI: `git checkout
  // --ours/--theirs && git add && git commit`, or `git merge --abort`) while
  // OK was closed. Without this reconcile, the boot scan would re-seed
  // `lifecycle.status='conflict'` on docs git already considers clean — the
  // DiffView would mount with no actual stages to show ("Loading conflict
  // for <path>" indefinitely because conflicts.json + lifecycle disagree
  // with /api/sync/conflicts after the sync engine's own reconcile clears
  // the store).
  let stillUnmerged: Set<string> | null = null;
  try {
    // Linked-worktree safety: `<projectDir>/.git` is a regular file (not a
    // directory) when running from a `git worktree add`-created tree. The
    // real gitdir is `<repo>/.git/worktrees/<name>/`, and MERGE_HEAD lives
    // there. A hardcoded `join(projectDir, '.git', 'MERGE_HEAD')` would
    // miss it and silently drop conflict entries. `resolveGitDir` reads
    // the gitdir pointer when present.
    const gitDir = resolveGitDir(projectDir);
    const mergeHeadPath = gitDir ? join(gitDir, 'MERGE_HEAD') : null;
    if (!mergeHeadPath || !existsSync(mergeHeadPath)) {
      // No merge in progress — every entry is stale.
      store.clear();
      console.warn(
        JSON.stringify({
          event: 'lifecycle-restore-cleared-stale-conflicts',
          reason: 'no-merge-head',
          count: entries.length,
        }),
      );
      return;
    }
    const pg = simpleGit({ baseDir: projectDir, timeout: { block: 5_000 } });
    stillUnmerged = new Set(await listNames(pg, ['diff', '--name-only', '--diff-filter=U']));
  } catch (err) {
    // Probe failed — fall through and restore everything; the sync
    // engine's own reconcile on `start()` will mop up any stragglers.
    log.warn(
      { err, projectDir },
      '[boot] lifecycle restore: git unmerged probe failed — restoring all entries',
    );
  }

  // Prune entries git considers resolved (still-unmerged probe succeeded).
  if (stillUnmerged !== null) {
    let pruned = 0;
    for (const entry of entries) {
      if (!stillUnmerged.has(entry.file)) {
        store.removeConflict(entry.file);
        pruned++;
      }
    }
    if (pruned > 0) {
      console.warn(
        JSON.stringify({
          event: 'lifecycle-restore-pruned-resolved-entries',
          pruned,
          remaining: entries.length - pruned,
        }),
      );
    }
    entries = entries.filter((e) => stillUnmerged?.has(e.file));
    if (entries.length === 0) return;
  }

  for (const entry of entries) {
    // TODO(content.dir-aware-boot-restore): `ConflictEntry.file` is
    // project-relative (git root); docName is contentDir-relative with
    // the supported doc extension stripped. The two coincide when
    // `projectDir === contentDir` (the default), but when `content.dir`
    // is set to a subdirectory of `projectDir` (schema-supported), `stripDocExtension`
    // alone misroutes — `docs/foo.md` yields docName `docs/foo` instead
    // of `foo`, and `openDirectConnection` opens a different / phantom
    // doc. The sibling on-load helper at `conflict-lifecycle-seed.ts:
    // entryMatchesDocName` does the correct `join` + `relative` +
    // `stripDocExtension` mapping. Threading `contentDir` into this
    // function and sharing one helper between both sites is the right
    // fix; no shipped project is known to use `content.dir != "."`.
    const docName = stripDocExtension(entry.file);
    let dc: Awaited<ReturnType<typeof hocuspocus.openDirectConnection>> | null = null;
    let restored = false;
    try {
      dc = await hocuspocus.openDirectConnection(docName);
      const document = dc.document;
      if (!document) continue;
      const lifecycleMap = document.getMap('lifecycle');
      lifecycleMap.set('status', 'conflict');
      lifecycleMap.set('reason', 'conflict-markers');
      restored = true;
      // Structured-JSON event — assertable in tests.
      console.warn(
        JSON.stringify({
          event: 'lifecycle-restored-from-conflicts-json',
          'doc.name': docName,
        }),
      );
    } catch (err) {
      log.warn(
        { err, docName },
        '[boot] lifecycle restore: failed to set lifecycle for doc — skipping',
      );
    } finally {
      // Disconnect failures are independent of whether the lifecycle write
      // succeeded — surface them as their own warn so operators don't
      // misread a successful restore as a failure.
      if (dc) {
        try {
          await dc.disconnect();
        } catch (err) {
          log.warn(
            { err, docName, restored },
            '[boot] lifecycle restore: disconnect failed after lifecycle write',
          );
        }
      }
    }
  }
}
