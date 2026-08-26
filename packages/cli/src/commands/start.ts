/**
 * `open-knowledge start` — the OpenKnowledge project server.
 *
 * One listener, one origin: by default the server serves the React shell on
 * `/` alongside `/api/*`, `/mcp`, `/collab`, and content assets, and
 * advertises the one URL via `server.lock` (`url` + `capabilities: ["ui"]` —
 * the Desktop attach contract). A second `ok start` against a live server
 * reports that URL and exits 0 (spawn-or-reuse) instead of colliding.
 *
 * The legacy two-process model (an `ok ui` sibling serving the shell and
 * proxying `/api` + `/collab`, advertised via `ui.lock`) is gone: the `ok ui`
 * command and the sibling auto-spawn were removed once the Desktop attach
 * re-point shipped stable, and the deprecated `--only ui` / `--server-url`
 * split-mode proxy retired with `ui.lock`. `--only server` (headless API + MCP,
 * no UI module) is the one `--only` value that remains.
 *
 * The Commander action is a thin wrapper around `bootStartServer` — that
 * boot function returns a `BootedStartServer` handle (`{httpServer, destroy,
 * port, ready, ...}`) so integration tests can drive the same composed boot
 * path the CLI uses, without process-level signal coupling.
 */
import { spawn as nativeSpawn } from 'node:child_process';
import { existsSync as fsExistsSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve as pathResolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  applyConfigOverlay,
  DEFAULT_SERVER_HOST,
  type EnvConfigLayer,
  EnvVarError,
  IDLE_SHUTDOWN_DURATION_RE,
  idleShutdownToMs,
  OK_DIR,
  resolveEnvConfigLayer,
  resolveServerRuntimeConfig,
  type ServerRuntimeConfig,
} from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import {
  type BootedServer,
  type Config,
  EPHEMERAL_PROJECT_DIR_PREFIX,
  isProjectRoot,
  lockAdvertisesUi,
  type PinoLogger,
  prepareSingleFileOpen,
  type ServerExitReason,
} from '@inkeep/open-knowledge-server';
import { Command, InvalidArgumentError, Option } from 'commander';
import { makeLazyEmbeddingsKeyStore } from '../auth/embeddings-key-store.ts';
import { detectGh, detectGhAccounts } from '../auth/gh-detect.ts';
import { makeLazyProbeTokenStore } from '../auth/token-store.ts';
import { PACKAGE_VERSION } from '../constants.ts';
import { getNativeTomlMcpEditor } from '../native/toml-config-engine.ts';
import { probeOwnManagedEditorMcpEntry } from './acp-harness-probe.ts';
import {
  createRealDetectDeps,
  detectDesktop,
  launchDesktop,
  notFoundMessage,
} from './desktop-dispatch.ts';
import { ensurePiBridge, probePiBridgeState } from './pi-acp-bridge.ts';

/** 30 minutes — default threshold. */
const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Resolve a single bind host with `--bind` flag > `HOST` env > application
 * default precedence. Pure helper — no side effects, no `process.env` access
 * inside (env passed in) so tests can pin all branches. Used by the ephemeral
 * single-file path; `ok start` proper resolves the full bind LIST (config/env
 * layers included) inline.
 */
export function resolveHost(
  opts: { bind?: string[] },
  env: { HOST?: string | undefined; [key: string]: string | undefined },
): string {
  return opts.bind?.[0] ?? env.HOST ?? DEFAULT_SERVER_HOST;
}

/** Modules selectable via `--only` — explicit operator module selection. */
export type OnlyModule = 'server';

/**
 * Validator for Commander's `--only` parser. Throws `InvalidArgumentError`
 * for anything outside the documented enum, which Commander converts into a
 * non-zero exit + usage. `'ui'` (the split-mode proxy) was retired with
 * `ui.lock`; only `'server'` (headless API + MCP) remains.
 */
export function parseOnlyModule(value: string): OnlyModule {
  if (value === 'server') return value;
  throw new InvalidArgumentError("--only must be 'server'");
}

/**
 * Resolve the bundled React shell `dist` directory — published `dist/public`
 * first, then the monorepo `app/dist`. One resolver shared by plain
 * `ok start` and the ephemeral single-file browser fallback so dev and
 * published builds can never disagree on where the shell lives.
 */
export function resolveBundledReactShellDir(
  existsFn: (path: string) => boolean = fsExistsSync,
): string | undefined {
  const cliDir = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
  return [
    pathResolve(cliDir, 'public'), // npm install: dist/public/ (bundled)
    pathResolve(cliDir, '../../app/dist'), // monorepo dev from src/
    pathResolve(cliDir, '../../../app/dist'), // monorepo dev from dist/
  ].find((p) => existsFn(p));
}

/**
 * Decide which React-shell directory the composed server serves — pure so
 * every branch is unit-tested:
 *
 * - an explicit `--react-shell-dist-dir` always wins;
 * - `--only server` opts out of the UI module entirely;
 * - otherwise the bundled shell is resolved and served by default. A missing
 *   bundle (source checkout without an app build) degrades to API/MCP-only.
 */
export function resolveStartShellDir(input: {
  explicitDir: string | undefined;
  only: OnlyModule | undefined;
  findBundledDir: () => string | undefined;
}): { dir: string | undefined; missingBundle: boolean } {
  if (input.explicitDir !== undefined) return { dir: input.explicitDir, missingBundle: false };
  if (input.only === 'server') return { dir: undefined, missingBundle: false };
  const dir = input.findBundledDir();
  return { dir, missingBundle: dir === undefined };
}

/**
 * Validator for `--idle-shutdown <dur|off>`: `off`, or a strict `<n>(s|m|h)`
 * duration. Returns the validated string unchanged — conversion to ms (or
 * `null` for `off`) happens at the boot boundary via {@link idleShutdownToMs},
 * exactly as the env/file/derived `server.idleShutdown` value does, so the flag
 * and the key resolve identically. The grammar mirrors the `server.idleShutdown`
 * leaf via `IDLE_SHUTDOWN_DURATION_RE`.
 *
 * Returning the string (not the ms number / `null`) is load-bearing: Commander
 * silently coerces a `null`/`undefined` option-parser result to `''`, which the
 * downstream `?? DEFAULT` misses and the idle timer reads as `0` ms — firing
 * idle-shutdown on boot. A non-empty string survives Commander intact.
 */
export function parseIdleShutdownFlag(value: string): string {
  if (value === 'off') return 'off';
  if (!IDLE_SHUTDOWN_DURATION_RE.test(value)) {
    throw new InvalidArgumentError("--idle-shutdown must be 'off' or a duration like 90s, 30m, 2h");
  }
  return value;
}

/** Loopback-shaped bind hosts — the family the browser-open default keys on. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
}

/**
 * Should a `HOST`-driven bind warn that it is silently dropping a multi-element
 * `server.bind`? `HOST` is a single-address platform-injection variable
 * (Heroku/Railway); when it — and neither `--bind` nor `OK_BIND` —
 * drives the bind, it REPLACES the whole file-layer list, halving a dual-stack
 * config with no record the way `OK_BIND` overrides carry. Pure so the boundary
 * (`> 1`, not `>= 1`) is unit-tested independent of the boot path.
 */
export function shouldWarnHostOverridesMultiBind(input: {
  flagBindSet: boolean;
  okBindSet: boolean;
  hostEnvSet: boolean;
  fileBindCount: number;
}): boolean {
  return !input.flagBindSet && !input.okBindSet && input.hostEnvSet && input.fileBindCount > 1;
}

/**
 * Should this start open the browser? Interactive loopback starts open by
 * default (suppress with `--no-open-browser`); everything non-interactive or
 * non-local stays quiet. Pure so the whole decision table is unit-tested. The
 * suppression conditions, in order:
 *
 * - `--no-open-browser` always suppresses;
 * - ephemeral single-file (owns its own open flow), `--only server`, and a
 *   start that ended up serving no shell never open;
 * - otherwise: open iff the bind is loopback AND stdout is a TTY (a spawned
 *   or CI invocation must not pop a browser). An EXPLICIT
 *   `server.openBrowser: true` / `OK_OPEN_BROWSER=1` (`explicitOn`) lifts
 *   the loopback-bind condition — the operator asked by name — but keeps
 *   the TTY gate so a container or spawned start still never pops one.
 */
export function shouldOpenBrowser(input: {
  openBrowser: boolean;
  explicitOn: boolean;
  host: string;
  isTTY: boolean;
  ephemeral: boolean;
  only: OnlyModule | undefined;
  servesUi: boolean;
}): boolean {
  if (!input.openBrowser) return false;
  if (input.ephemeral || input.only === 'server') return false;
  if (!input.servesUi) return false;
  return (input.explicitOn || isLoopbackHost(input.host)) && input.isTTY;
}

/**
 * Validator for the `--external-url` flag — the flag-layer setter for
 * `server.externalUrl`, matching the schema leaf's http(s)-origin shape so a
 * flag value can never smuggle in what the config file would reject.
 */
function parseHttpOriginFlag(flagName: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidArgumentError(`${flagName} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidArgumentError(`${flagName} must be an http(s) origin (got: ${value})`);
  }
  return value;
}

export function parseExternalUrlFlag(value: string): string {
  return parseHttpOriginFlag('--external-url', value);
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

/**
 * Thrown by `bootStartServer` when `--single-file` is given a `--project-dir`
 * that is not the sanctioned throwaway shape (`ok-ephemeral-*` directly under
 * the OS temp dir) — whether bare or already initialized. Booting with an
 * ordinary directory as the ephemeral root would write `.ok/` state into a
 * directory the user may not consider disposable, and the shutdown reap would
 * then (rightly) decline to clean it up. Refuse up front with the working
 * alternatives instead.
 */
export class EphemeralProjectDirNotThrowawayError extends Error {
  readonly projectDir: string;
  constructor(projectDir: string) {
    super(
      `--project-dir must be a throwaway ${EPHEMERAL_PROJECT_DIR_PREFIX}* directory under the OS temp dir. ` +
        `Refusing to write ephemeral session state into ${projectDir}. ` +
        'Omit --project-dir to let ok start create (and clean up) its own.',
    );
    this.name = 'EphemeralProjectDirNotThrowawayError';
    this.projectDir = projectDir;
  }
}

/**
 * Provenance check for the destructive ephemeral reap: the CANONICAL target
 * must be a direct `ok-ephemeral-*` child of `os.tmpdir()` — the exact shape
 * `createEphemeralProjectDir` mints. The reap recursively deletes its target,
 * so it must never trust a flag value alone: `--project-dir` is user-reachable,
 * and an earlier cwd fallback let the reap delete a real project (content,
 * `.git`, everything) on idle shutdown.
 *
 * The whole path is realpath-resolved before the check: a symlinked temp-root
 * prefix (macOS `/tmp` → `/private/tmp`, `/var` → `/private/var`) still
 * matches, and a symlink LEAF named `ok-ephemeral-*` resolves to its target,
 * so a link pointing at a real project fails the check and is refused. When
 * the leaf does not exist (already reaped), its parent is still resolved and
 * the literal basename is kept. Any other realpath failure (EACCES, ELOOP,
 * EIO) fails CLOSED: a path that cannot be trusted is not a reap target.
 * Never throws. Deps are injectable for tests.
 */
export function isReapableEphemeralProjectDir(
  dir: string,
  deps: { tmpdirFn?: () => string; realpathFn?: (path: string) => string } = {},
): boolean {
  const tmpdirFn = deps.tmpdirFn ?? tmpdir;
  const realpathFn = deps.realpathFn ?? realpathSync;
  const canonical = (path: string): string | null => {
    try {
      return realpathFn(path);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? pathResolve(path) : null;
    }
  };
  const literal = pathResolve(dir);
  let target: string | null;
  try {
    target = realpathFn(literal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const parent = canonical(dirname(literal));
      target = parent === null ? null : pathResolve(parent, basename(literal));
    } else {
      target = null;
    }
  }
  if (target === null) return false;
  const tmpRoot = canonical(tmpdirFn());
  if (tmpRoot === null) return false;
  return dirname(target) === tmpRoot && basename(target).startsWith(EPHEMERAL_PROJECT_DIR_PREFIX);
}

/**
 * Wrap an idle-shutdown handler so that, after the server is destroyed, the
 * ephemeral session's throwaway temp projectDir is removed. Without this an
 * agent- or tab-closed single-file session leaks its temp dir — boot's destroy
 * alone releases the locks but leaves the dir on disk. Reaping is best-effort
 * (the dir lives in os.tmpdir and is OS-reaped regardless). `rmFn` is
 * injected for testing.
 *
 * The reap REFUSES any target that fails `isReapableEphemeralProjectDir` —
 * this is the containment backstop for a recursive delete of a user-influenced
 * path, and it must stay in front of every rm this wrapper performs. The
 * predicate is deliberately NOT injectable: an injection seam here is a
 * bypass door for the one check standing between a flag value and `rm -rf`.
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
      if (isReapableEphemeralProjectDir(projectDir)) {
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
      } else {
        // A non-throwaway target means a caller wired a real directory into the
        // ephemeral teardown — leave it in place rather than delete user data.
        process.stderr.write(
          `[start] leaving ${projectDir} in place: only ${EPHEMERAL_PROJECT_DIR_PREFIX}* dirs under the OS temp dir are removed on ephemeral teardown\n`,
        );
      }
    }
  };
}

/**
 * Wrap the idle-shutdown handler so the process EXITS once teardown
 * completes. Without this, exit relies on the event loop draining naturally —
 * and any handle the destroy sequence doesn't cover (a native watcher
 * subscription that didn't fully detach, a lingering pipe) leaves an
 * immortal zombie: a process that released its lock and closed its port
 * hours ago but still sits in memory holding the project's in-memory state.
 * The signal path already exits explicitly after destroy; this gives the
 * idle path the same discipline.
 *
 * Before exiting, log a bounded summary of still-open handles (constructor
 * names + counts via the undocumented-but-stable `process._getActiveHandles`)
 * so the leak class that WOULD have zombified gets named in the wild instead
 * of silently absorbed by the exit.
 *
 * Exit runs in `finally` — a throwing destroy must still terminate the
 * process (exit code 1), otherwise the zombie returns exactly when teardown
 * is least healthy.
 */
export function withIdleShutdownProcessExit(
  handler: () => Promise<void>,
  deps: {
    log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
    exit?: (code: number) => void;
    /** Return `null` when the runtime does not expose active handles (Bun). */
    getActiveHandles?: () => unknown[] | null;
  } = {},
): () => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const getActiveHandles =
    deps.getActiveHandles ??
    (() => {
      // Bun does not implement `_getActiveHandles` — report "unavailable"
      // (null) rather than an empty list, so an empty summary in the logs
      // is distinguishable from a runtime that simply can't see handles.
      const probe = (process as unknown as { _getActiveHandles?: () => unknown[] })
        ._getActiveHandles;
      return probe ? probe.call(process) : null;
    });
  return async () => {
    let failed = false;
    try {
      await handler();
    } catch (err) {
      failed = true;
      // Pass the Error object itself — pino's std serializer keeps the stack;
      // a pre-stringified message would drop it.
      deps.log?.error({ err }, 'idle-shutdown: destroy failed — exiting anyway');
    } finally {
      let handleSummary: Record<string, number> | null = null;
      try {
        const handles = getActiveHandles();
        if (handles !== null) {
          handleSummary = {};
          for (const handle of handles) {
            const name =
              (handle as { constructor?: { name?: string } } | null)?.constructor?.name ??
              'unknown';
            handleSummary[name] = (handleSummary[name] ?? 0) + 1;
          }
        }
      } catch {
        handleSummary = null;
      }
      deps.log?.info(
        {
          event: 'idle-shutdown-exit',
          exitCode: failed ? 1 : 0,
          openHandles: handleSummary ?? {},
          handlesAvailable: handleSummary !== null,
        },
        'idle-shutdown: teardown finished — exiting process',
      );
      exit(failed ? 1 : 0);
    }
  };
}

interface BootStartServerOptions {
  config: Config;
  cwd: string;
  /**
   * Server bind host. Source ordering at the call site is `--bind` flag →
   * `HOST` env → `DEFAULT_SERVER_HOST`. Resolved at the start command,
   * not via config — `server.host` is no longer a schema field.
   */
  host: string;
  /**
   * Server bind port. `server.port` is a schema key but this boot path does
   * NOT read it yet — that wiring lands with the unified server boot. Source
   * ordering at the call site is `--port` flag → `PORT` env → `0`
   * (kernel-allocated). `0` or `undefined` triggers kernel allocation;
   * `bootServer` writes the resolved port into `server.lock` for MCP clients
   * to discover.
   */
  port?: number;
  /**
   * When `true`, bypasses the init-required guard — `bootStartServer` will not
   * throw `OkDirMissingError` even when `.ok/config.yml` is absent. Integration
   * tests that pre-seed `.ok/config.yml` manually should still pass
   * `skipAutoInit: true` to make their intent explicit; tests exercising the
   * no-config rejection should omit this or set it to `false`.
   */
  skipAutoInit?: boolean;
  /** Override idle-shutdown threshold; default 30 min. `null` disables idle
   *  shutdown entirely (`--idle-shutdown off`). Tests use small values. */
  idleThresholdMs?: number | null;
  /**
   * The fully-layered `server.*` resolution (flags > env > project-local >
   * project > user), threaded to `bootServer` so Host/Origin admission and the
   * exposure interlock consume the same values the CLI resolved. Omitted by
   * legacy callers — `bootServer` then resolves files-only from its config.
   */
  serverRuntime?: ServerRuntimeConfig;
  /**
   * Full bind-address list for multi-listener bind (first entry decides the
   * port; the rest share it). Omitted ⇒ single listener on `host`.
   */
  bind?: readonly string[];
  /**
   * Override the process-exit call fired after an idle-shutdown teardown
   * completes (see `withIdleShutdownProcessExit`). Default `process.exit`.
   * Tests that drive idle-shutdown through `bootStartServer` MUST inject
   * this — the default would take down the test runner.
   */
  idleExit?: (code: number) => void;
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
   * When `true` (the `bootServer` default), the server serves
   * content-directory assets (images/video/PDF/file attachments) at their
   * `/<contentDir-relative>` paths via `createAssetServeMiddleware` —
   * matching the Vite dev plugin. On by default so a desktop window that
   * ATTACHES to this server (MCP-autostarted or terminal `ok start` — its
   * renderer fetches assets from the same origin as `/api/*` and `/collab*`)
   * renders inline images. Forwards directly to
   * `BootServerOptions.serveContentAssets`.
   */
  serveContentAssets?: boolean;
  /**
   * Absolute path to a bundled React shell directory (Vite's `build.outDir`
   * for `@inkeep/open-knowledge-app`). When set, the server serves the
   * shell on `/` (and `/assets/*` etc.) via sirv's SPA fallback. The
   * desktop passes its bundled shell path so external agent in-app browsers
   * (Claude Desktop, Cursor) can render the UI at the same origin as
   * `/api/*`. Forwards directly to `BootServerOptions.reactShellDistDir`.
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
   * With `projectDir` set, the caller (`runSingleFileBrowserOpen` / the desktop
   * spawn) owns the temp dir's lifecycle and removes it on teardown; without
   * it, `bootStartServer` creates its own throwaway dir and reaps it on
   * destroy and idle shutdown.
   */
  singleFile?: string;
  /**
   * Explicit project root, distinct from `cwd`. Only meaningful in the
   * ephemeral single-file path, where it is the throwaway temp dir carrying the
   * synthesized `.ok/config.yml` (seeded on boot when missing). When absent in
   * that path, a fresh temp dir is created — never `cwd`: a real project as the
   * ephemeral root gets recursively deleted by the idle-shutdown reap.
   */
  projectDir?: string;
}

export interface BootedStartServer {
  /** The bound HTTP server listening on `port`. */
  httpServer: HttpServer;
  /** Composite shutdown — closes httpServer, detaches idle-shutdown, destroys the Hocuspocus server (which releases server.lock). */
  destroy: (reason?: ServerExitReason) => Promise<void>;
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
}

/**
 * Boot the collab server end-to-end and return a handle. Pure of process-level
 * concerns (signal handlers, banner, browser-open, exit codes) so integration
 * tests can drive it directly. The Commander action layers signals + UX on top.
 *
 * The HTTP + WebSocket + listen + lock + idle-shutdown plumbing lives in
 * `@inkeep/open-knowledge-server`'s `bootServer()`; this wrapper adds
 * CLI-specific concerns (init-required guard, resolveContentDir,
 * open-browser-on-first-agent-edit).
 */
export async function bootStartServer(opts: BootStartServerOptions): Promise<BootedStartServer> {
  const { config, cwd, host } = opts;
  const skipAutoInit = opts.skipAutoInit ?? false;
  // Explicit undefined check (not `??`): `null` means "idle shutdown OFF"
  // (`--idle-shutdown off`) and must not fall back to the 30-min default.
  const idleThresholdMs =
    opts.idleThresholdMs === undefined ? DEFAULT_IDLE_THRESHOLD_MS : opts.idleThresholdMs;

  const { existsSync, mkdirSync } = await import('node:fs');
  const { basename, dirname, resolve } = await import('node:path');
  const {
    bootServer,
    createEphemeralProjectDir,
    getLogger,
    resolveContentDir,
    resolveLockDir,
    seedEphemeralProjectDir,
    waitForServerLockDrain,
  } = await import('@inkeep/open-knowledge-server');

  const log = opts.log ?? getLogger('start');

  // No-project ephemeral single-file mode. The file genuinely lives inside
  // `contentDir` (its real parent), so write-back lands on it through the
  // existing atomic-write spine without tripping the symlink-escape gate; the
  // `.ok/` state lives only in the throwaway `projectDir`. The init-required
  // guard + reclaim sweeps target a real project — neither applies here.
  const ephemeral = opts.singleFile !== undefined;
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

  // Establish the ephemeral project root this boot consumes — the invariant is
  // that whoever boots the ephemeral shape provisions its throwaway projectDir.
  // A parent-provided `--project-dir` (the desktop / `ok <file>` spawn ABI) is
  // used as-is, seeded if its synthesized config is missing; with no
  // `--project-dir`, a fresh temp dir is created HERE and owned by this boot
  // (reaped on destroy and on idle shutdown). Never fall back to cwd: an
  // initialized cwd passes the boot config gate and the ephemeral teardown
  // would then recursively delete a real project on idle shutdown.
  let ephemeralProjectDir: string | undefined;
  let ownsEphemeralProjectDir = false;
  if (ephemeralContentDir !== undefined) {
    if (opts.projectDir !== undefined) {
      ephemeralProjectDir = opts.projectDir;
      // EVERY provided --project-dir must be the sanctioned throwaway shape,
      // config or no config. Gating only the seeding branch would wave through
      // an initialized real project (it has a config), boot with it as the
      // ephemeral root, and scatter `.ok/local/` runtime state into it — the
      // exact input class the cwd fallback destroyed. Both spawn-ABI producers
      // pass a `createEphemeralProjectDir` result, which satisfies this.
      if (!isReapableEphemeralProjectDir(ephemeralProjectDir)) {
        throw new EphemeralProjectDirNotThrowawayError(ephemeralProjectDir);
      }
      if (!existsSync(resolve(ephemeralProjectDir, OK_DIR, 'config.yml'))) {
        seedEphemeralProjectDir(ephemeralProjectDir, ephemeralContentDir);
      }
    } else {
      ephemeralProjectDir = createEphemeralProjectDir(ephemeralContentDir);
      ownsEphemeralProjectDir = true;
    }
  }
  // Best-effort cleanup for the self-provisioned dir when boot fails below —
  // the parent-provided dir stays the parent's to remove. Failures are logged,
  // not swallowed: this process is the dir's sole owner, so a silent rm
  // failure would orphan `ok-ephemeral-*` dirs with no diagnostic trail.
  const reapOwnedEphemeralDir = async (): Promise<void> => {
    if (!ownsEphemeralProjectDir || ephemeralProjectDir === undefined) return;
    if (!isReapableEphemeralProjectDir(ephemeralProjectDir)) {
      // Can only fire if the dir this process minted stopped resolving to the
      // throwaway shape between mint and teardown — something replaced it
      // under a running session. Worth a trail, not silence.
      log.warn(
        { ephemeralProjectDir },
        '[start] refusing to reap self-provisioned ephemeral dir: no longer resolves to an ok-ephemeral-* temp dir',
      );
      return;
    }
    try {
      await rm(ephemeralProjectDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(
        { err, ephemeralProjectDir },
        '[start] failed to reap self-provisioned ephemeral temp dir',
      );
    }
  };
  // `const` capture: `let` narrowing does not survive into the idle-shutdown
  // closure passed to bootServer below.
  const reapDirOnIdle = ephemeralProjectDir;

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

    // Sibling sweep for `.claude/launch.json` — OK no longer scaffolds one,
    // so this removes any stale `open-knowledge-ui` entry a prior OK version
    // left behind (co-located user configs are preserved).
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

  // A predecessor server mid-teardown holds its lock (marked draining) until
  // it actually exits. Racing it would collide loudly inside createServer, so
  // wait for the drain to finish first — restart flows (desktop respawn, MCP
  // auto-start, manual `ok start` right after closing a window) land here
  // within the predecessor's last seconds. On timeout we proceed anyway and
  // let the acquire collide: a wedged teardown should fail loud, not spawn a
  // duplicate.
  // From here to the end of bootServer a throw must clean up the
  // self-provisioned ephemeral dir — the caller never learns the path, so an
  // unreaped dir on a failed boot is unattributable.
  let booted: BootedServer;
  try {
    {
      const drainLockDir = resolveLockDir(ephemeralProjectDir ?? cwd);
      const drainWaitStartedAt = Date.now();
      const drainOutcome = await waitForServerLockDrain(drainLockDir);
      if (drainOutcome !== 'no-drain') {
        // `waitedMs` is the tuning signal for the 10s drain timeout: released
        // durations creeping toward it mean real teardowns are outgrowing the
        // budget and would start colliding under normal load.
        log.info(
          {
            event: 'start-waited-for-draining-predecessor',
            outcome: drainOutcome,
            waitedMs: Date.now() - drainWaitStartedAt,
            drainLockDir,
          },
          drainOutcome === 'released'
            ? '[start] predecessor server finished draining — proceeding'
            : '[start] predecessor server still draining after wait — proceeding to collide',
        );
      }
    }

    booted = await bootServer({
      config,
      contentDir,
      projectDir: ephemeralProjectDir ?? cwd,
      contentRoot: ephemeral ? undefined : config.content.dir,
      port: opts.port,
      host,
      quiet: false,
      detectGh,
      detectGhAccounts,
      tokenStore,
      embeddingsKeyStore,
      mcpTomlEditor: getNativeTomlMcpEditor(),
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
      // ACP threads skip injecting the `open-knowledge` MCP server when the
      // agent's own harness already loads OK's managed editor-config entry.
      probeHarnessManagedMcpEntry: (editorId, agentCwd) =>
        probeOwnManagedEditorMcpEntry(editorId, agentCwd),
      // Pi has no MCP client, so its ACP threads get OK tools from the managed
      // bridge extension in the project instead — probed at session setup and,
      // with the user's consent, provisioned there and then.
      probePiAcpBridge: (agentCwd) => probePiBridgeState(agentCwd),
      ensurePiAcpBridge: (agentCwd) => ensurePiBridge(agentCwd),
      // CLI-specific opt-ins
      idleShutdownMs: idleThresholdMs,
      ...(opts.serverRuntime !== undefined ? { serverRuntime: opts.serverRuntime } : {}),
      ...(opts.bind !== undefined ? { bind: opts.bind } : {}),
      skipAutoInit: true, // Guard already ran above; no scaffold fn to pass
      idleShutdownHandler: (destroyServer) => {
        const handler = destroyServer;
        const reaped =
          reapDirOnIdle !== undefined ? withEphemeralTempDirReap(handler, reapDirOnIdle) : handler;
        // Outermost: the exit fires only after destroy AND the ephemeral temp
        // dir reap have both run.
        return withIdleShutdownProcessExit(reaped, { log, exit: opts.idleExit });
      },
      log,
      // Content assets serve by default (bootServer default-on). The React
      // shell dir is passed through when present — the default for plain
      // `ok start` — so the one-listener composition is the norm.
      ...(opts.serveContentAssets !== undefined
        ? { serveContentAssets: opts.serveContentAssets }
        : {}),
      ...(opts.reactShellDistDir ? { reactShellDistDir: opts.reactShellDistDir } : {}),
    });
  } catch (err) {
    await reapOwnedEphemeralDir();
    throw err;
  }

  // A parent-provided dir stays the parent's to remove (the desktop and the
  // `ok <file>` browser path both reap their own temp dir on teardown); the
  // self-provisioned dir has no other owner, so destroy() reaps it here.
  const innerDestroy = booted.destroy;
  const destroy = ownsEphemeralProjectDir
    ? async (): Promise<void> => {
        try {
          await innerDestroy();
        } finally {
          await reapOwnedEphemeralDir();
        }
      }
    : innerDestroy;

  return {
    httpServer: booted.httpServer,
    destroy,
    lockDir: booted.lockDir,
    contentDir,
    port: booted.port,
    ready: booted.ready,
    degraded: booted.degraded,
  };
}

/** Parsed `--mode <browser|app>` option. */
type StartMode = 'browser' | 'app';

interface StartCommandOptions {
  port?: string | number;
  /** From repeatable `--bind <address>`. First value wins today; >1 rejected at the action layer. */
  bind?: string[];
  /**
   * From `--no-open-browser` (Commander negation: absent → `true`). Interactive
   * loopback starts open the browser by default; this is the suppression
   * direction — see `shouldOpenBrowser` for the full decision table.
   */
  openBrowser?: boolean;
  /**
   * From `--only server`: boot the project server with no UI module (no shell,
   * no browser) — the headless / container profile.
   */
  only?: OnlyModule;
  /**
   * From `--idle-shutdown <dur|off>`, validated by `parseIdleShutdownFlag`: the
   * duration string (`'off'` | `'90s'` | `'30m'` | …), or absent when the flag
   * is not passed. Converted to ms (null for `'off'`) at the boot boundary via
   * `idleShutdownToMs`, alongside the env/file/derived value.
   */
  idleShutdown?: string;
  /** From `--mode`: undefined (default → browser) | 'browser' | 'app'. */
  mode?: StartMode;
  /**
   * From `--serve-content-assets`. Redundant now that `bootServer` defaults
   * the surface on; accepted for compatibility with older desktop spawners
   * that still pass the flag. See `BootStartServerOptions.serveContentAssets`.
   */
  serveContentAssets?: boolean;
  /** From `--react-shell-dist-dir <path>`. See `BootStartServerOptions.reactShellDistDir`. */
  reactShellDistDir?: string;
  /** From `--single-file <path>`. See `BootStartServerOptions.singleFile` — boots
   *  the no-project ephemeral single-file shape (the desktop spawn passes it). */
  singleFile?: string;
  /** From `--project-dir <dir>`. See `BootStartServerOptions.projectDir` — the
   *  throwaway temp project root for the ephemeral single-file shape. */
  projectDir?: string;
  /** From `--external-url <url>`: flag-layer `server.externalUrl` for this run. */
  externalUrl?: string;
}

/**
 * Resolve the file-layer config for a `start` invocation. An ephemeral
 * single-file session drops the PROJECT layers: the CLI's cwd anchor points
 * at whatever project the shell happens to sit in, which is unrelated to the
 * loose file being opened — inheriting its `server.*` settings made the same
 * session behave differently by cwd. The user-global `~/.ok/global.yml`
 * layer SURVIVES, matching `ok <file>` (whose `loadConfig(ephemeralRoot)`
 * reads user-global plus the synthesized project config, which contributes
 * only `content.dir` — overridden explicitly by the ephemeral boot anyway).
 * Flags and env still override through the normal precedence.
 *
 * The user-layer read does not sideline a broken file (the primary
 * `loadConfig` this session already did that and reported it); it degrades
 * to schema defaults. `readUserConfig` is injected for tests.
 */
export function resolveStartConfig(
  config: Config,
  singleFile: string | undefined,
  readUserConfig: () => Config = () =>
    readConfigSafely({
      absPath: resolveConfigPath('user', process.cwd()),
      sideline: false,
      warn: () => {},
    }).value,
): Config {
  return singleFile !== undefined ? readUserConfig() : config;
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
 * Decide the stdout log level for an interactive `ok start`. The terminal
 * should stay legible — banner + warnings, not a firehose of INFO diagnostics
 * — but those diagnostics must still reach the on-disk file sink for
 * bug-report bundles. Returning 'warn' raises ONLY the pretty stdout stream
 * (see `OK_CONSOLE_LEVEL` in `logger.ts`); the file sink keeps capturing
 * diagnostics independently (debug+ by default; `OK_FILE_LEVEL` overrides).
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
export async function runStartCommand(configArg: Config, opts: StartCommandOptions): Promise<void> {
  const config = resolveStartConfig(configArg, opts.singleFile);
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

  // Set the process title as early as possible so Activity Monitor and
  // `ps -ax | grep open-knowledge-server` show each running server by
  // project name. This is the primary user-facing surface for orphan
  // management — there's no in-app "Stop server"
  // action; the OS process list is the discovery path.
  process.title = deriveServerProcessTitle(cwd);

  // The env config layer (the mechanical OK_* surface + platform PORT):
  // parsed once, leaf-validated, fail-loud on a malformed value with the
  // variable named. Did-you-mean observations surface as warnings.
  let envLayer: EnvConfigLayer;
  try {
    envLayer = resolveEnvConfigLayer(process.env);
  } catch (err) {
    if (err instanceof EnvVarError) {
      console.error(error(err.message));
      process.exit(78);
    }
    throw err;
  }
  for (const diag of envLayer.diagnostics) {
    console.warn(warning(`[config] ${diag.message}`));
  }
  const envConfig = applyConfigOverlay(config, envLayer.layer) as Config;

  // Bind precedence: --bind flag > ratified OK_BIND > legacy HOST env >
  // server.bind file layer > loopback default. The resolved LIST is what the
  // derived defaults key off (openBrowser/idleShutdown derive from
  // loopback-only-ness); the listener binds every entry in the list
  // (multi-address bind), each on the same port.
  const okBindSet = envLayer.overrides.some((o) => o.envVar === 'OK_BIND');
  const flagBind = opts.bind !== undefined && opts.bind.length > 0 ? opts.bind : undefined;
  // Empty/whitespace `HOST` reads as unset, matching the env layer's
  // `PORT=''` handling — a platform that exports an empty `HOST` must not
  // produce a `['']` bind list (`''` is non-loopback, so it would trip the
  // exposure interlock with a nonsense "bind includes ()" message).
  const hostEnvRaw = process.env.HOST;
  const hostEnv = hostEnvRaw !== undefined && hostEnvRaw.trim() !== '' ? hostEnvRaw : undefined;
  const envFileRuntime = resolveServerRuntimeConfig(envConfig);
  const requestedBind =
    flagBind ?? (okBindSet || hostEnv === undefined ? [...envFileRuntime.bind] : [hostEnv]);

  // Warn when a `HOST`-driven bind silently drops a multi-element `server.bind`
  // (decision extracted + unit-tested; see shouldWarnHostOverridesMultiBind).
  if (
    shouldWarnHostOverridesMultiBind({
      flagBindSet: flagBind !== undefined,
      okBindSet,
      hostEnvSet: hostEnv !== undefined,
      fileBindCount: envFileRuntime.bind.length,
    })
  ) {
    console.warn(
      warning(
        `[config] HOST=${hostEnv} overrides server.bind — dropping the file-configured addresses (${envFileRuntime.bind.join(', ')}). Use OK_BIND with a space-separated list to keep multiple binds.`,
      ),
    );
  }

  const host = requestedBind[0] ?? DEFAULT_SERVER_HOST;
  const bindList = requestedBind;
  // The flag-layer overlay, applied ABOVE the env layer: the resolved bind
  // list plus `--external-url` (which writes server.externalUrl so the flag
  // layer keeps its precedence over env and file layers).
  const flagExternalUrl = opts.externalUrl;
  const runtime: ServerRuntimeConfig = resolveServerRuntimeConfig(
    applyConfigOverlay(envConfig, {
      server: {
        bind: bindList,
        ...(flagExternalUrl !== undefined ? { externalUrl: flagExternalUrl } : {}),
      },
    }) as Config,
  );

  // The exposure consent warning. `allowExternal` is the sanctioned
  // relaxation, but its blast radius is easy to under-read: it exposes not
  // just the editor/collab/API surface but the local-op owner surface (clone,
  // GitHub sign-in, PAT storage, repo spawn) to every external peer, with NO
  // server-side auth. Fire whenever consent is armed AND there is a real
  // exposure vector — a non-loopback bind (direct) or a declared externalUrl
  // (a same-host reverse proxy forwards to a loopback bind).
  if (runtime.allowExternal && (!runtime.loopbackOnly || runtime.externalUrl)) {
    const reach = runtime.externalUrl ?? runtime.bind.join(', ');
    console.warn(
      warning(
        [
          '',
          '⚠  EXTERNAL ACCESS ENABLED (server.allowExternal) — no server-side authentication.',
          `   This server is reachable beyond this machine (${reach}). Anyone who can`,
          '   reach it has FULL control of this knowledge base — sync, publishing, GitHub',
          '   credentials, and local operations (clone, sign-in, repo spawn).',
          '   Restrict who can reach it at the edge: a Tailscale ACL, a reverse proxy with',
          '   auth (Cloudflare Access, oauth2-proxy), or a firewall.',
          '',
        ].join('\n'),
      ),
    );
  }

  const portFromCli = opts.port !== undefined ? Number(opts.port) : undefined;
  const portFromEnv = envLayer.overrides.find((o) => o.envVar === 'PORT')?.value as
    | number
    | undefined;
  // An explicit --port wins; otherwise the platform-injected PORT env, then a
  // configured server.port. Unset → the caller picks a free dynamic port.
  const port = portFromCli ?? portFromEnv ?? config.server?.port;

  // The default composition serves the SPA from the server's own port (`/` =
  // UI, `/api`, `/mcp`, `/collab` — one listener, one origin).
  // `resolveStartShellDir` holds the decision table (explicit dir wins;
  // `--only server` opts out; everything else serves the shell by default).
  // A missing bundle degrades to API/MCP-only with a warning rather than
  // failing the start.
  const shell = resolveStartShellDir({
    explicitDir: opts.reactShellDistDir,
    only: opts.only,
    findBundledDir: resolveBundledReactShellDir,
  });
  const reactShellDistDir = shell.dir;
  if (shell.missingBundle) {
    console.warn(
      'bundled web UI not found — serving /api and /mcp only. Reinstall @inkeep/open-knowledge, or build packages/app in a source checkout.',
    );
  }

  let booted: BootedStartServer;
  try {
    booted = await bootStartServer({
      config,
      cwd,
      host,
      port,
      // Full bind list for the multi-listener bind (see `bindList` above).
      bind: bindList,
      ...(opts.serveContentAssets !== undefined
        ? { serveContentAssets: opts.serveContentAssets }
        : {}),
      ...(reactShellDistDir ? { reactShellDistDir } : {}),
      // Flag > env/file/derived, resolved uniformly: both the flag value and
      // the resolver's idleShutdown are duration strings ('off' | '90s' | …) —
      // the resolver's covers OK_IDLE_SHUTDOWN, the config leaf, and the
      // bind-derived default ('30m' loopback-only, 'off' exposed). Converted to
      // ms (null for 'off') at this single boundary. The flag stays a string
      // through Commander on purpose — see parseIdleShutdownFlag.
      idleThresholdMs: idleShutdownToMs(opts.idleShutdown ?? runtime.idleShutdown),
      serverRuntime: runtime,
      ...(opts.singleFile ? { singleFile: opts.singleFile } : {}),
      ...(opts.projectDir ? { projectDir: opts.projectDir } : {}),
    });
  } catch (err) {
    // Project not initialized — clean message, no stack trace.
    if (err instanceof OkDirMissingError) {
      console.error(error(err.message));
      process.exit(1);
    }

    // --project-dir refused (not a throwaway shape) — the message carries the
    // fix; render it cleanly like the other flag-validation rejections.
    if (err instanceof EphemeralProjectDirNotThrowawayError) {
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

    // Exposure without consent (non-loopback bind or externalUrl set while
    // server.allowExternal is off) — the interlock's message IS the one-line
    // fix. EX_CONFIG, same contract as the other config-shaped boot errors.
    if (err instanceof serverModule.ExposureConsentError) {
      console.error(error(err.message));
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

    // bootServer's own config gate (`.ok/config.yml` absent at the resolved
    // projectDir). The CLI guard above normally fires first; this arm covers
    // the remaining direct-flag shapes so the user gets the message, not a
    // stack trace.
    if (err instanceof serverModule.MissingOkConfigError) {
      console.error(error(err.message));
      process.exit(1);
    }

    // Spawn-or-reuse: a plain `ok start` that collided with a live server
    // reads the holder's advertisement, reports its URL, and exits 0 — a
    // second start attaches to the running composition instead of failing.
    // Falls through to the tailored/generic error path (exit 1) only when the
    // lock can't be resolved to a usable address within the poll window.
    if (isServerLockCollision(err, serverModule)) {
      const lockDir = serverModule.resolveLockDir(cwd);
      // A lock read can throw mid-poll (EMFILE, a JSON rewrite caught in
      // flight). Contain it so a transient disk error degrades to the tailored
      // collision message below rather than escaping as a raw stack trace.
      let reuse: ServerReuseInfo | null = null;
      try {
        reuse = await resolveServerReuse({
          readServerLock: () => serverModule.readServerLock(lockDir),
          now: Date.now,
          sleep: (ms) => wait(ms),
          timeoutMs: 3000,
          pollIntervalMs: 50,
        });
      } catch (reuseErr) {
        // Fall through to tryDescribeLockCollision / the generic error path —
        // but leave a trace: a lock read that throws mid-poll (EMFILE burst,
        // JSON caught mid-rewrite) would otherwise make "already running" or
        // the collision message appear with the underlying disk fault
        // invisible. stderr keeps stdout clean for scripts.
        process.stderr.write(
          `[start] spawn-or-reuse: lock poll failed (${reuseErr instanceof Error ? reuseErr.message : String(reuseErr)}) — falling back to the collision message\n`,
        );
      }
      if (reuse !== null) {
        const [headline, ...rest] = formatServerReuseNotice(reuse);
        console.log(accent(headline));
        for (const line of rest) {
          console.log(dim(line));
        }
        process.exit(0);
      }
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
      await booted.destroy('external-signal');
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

  // Bracket a bare IPv6 literal for the authority (`::1` → `[::1]`); an
  // unbracketed IPv6 host produces a malformed `http://::1:PORT` that the
  // browser-open default would now actually navigate to (--bind ::1 on a TTY).
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const apiUrl = `http://${urlHost}:${booted.port}`;
  const networkUrl =
    host === '0.0.0.0' || host === '::' ? `http://0.0.0.0:${booted.port}` : undefined;

  // One-listener composition: the server serves the shell itself, so the
  // editor URL IS the API URL.
  const localUrl = apiUrl;

  console.log(
    renderBanner({
      name: 'open-knowledge',
      version: PACKAGE_VERSION,
      localUrl,
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

      // Interactive loopback starts open the browser by default now that the
      // banner URL is the full editor (suppress with --no-open-browser).
      // Decision table: `shouldOpenBrowser`.
      const openDecision = shouldOpenBrowser({
        // Flag suppression wins; otherwise the resolver's openBrowser covers
        // OK_OPEN_BROWSER, the config leaf, and the bind-derived default.
        openBrowser: opts.openBrowser !== false && runtime.openBrowser,
        explicitOn: opts.openBrowser !== false && envConfig.server?.openBrowser === true,
        host,
        isTTY: process.stdout.isTTY === true,
        ephemeral: opts.singleFile !== undefined,
        only: opts.only,
        servesUi: reactShellDistDir !== undefined,
      });
      if (openDecision) {
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

/** What a reused (already-running) server advertises — see `resolveServerReuse`. */
export interface ServerReuseInfo {
  /** The browser-facing URL of the running composition. */
  url: string;
  /** Lock holder's `kind` (`interactive` = any direct boot, terminal or desktop; `mcp-spawned`). */
  kind?: string | undefined;
  pid: number;
  /** True when the running server itself serves the React shell (lock v2 `capabilities` includes `"ui"`). */
  servesUi: boolean;
}

interface ResolveServerReuseDeps {
  readServerLock: () => {
    pid: number;
    port: number;
    url?: string;
    kind?: string;
    draining?: boolean;
    capabilities?: string[];
  } | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollIntervalMs: number;
}

/**
 * Spawn-or-reuse resolution: a second `ok start` that lost the server.lock
 * acquisition reads the live holder's advertisement and reports it instead of
 * failing. Returns the holder's browser-facing URL, or `null` when the lock
 * can't be resolved to a usable address (caller falls back to the error path).
 *
 * Polls through the pre-listen window (`port: 0` sentinel) so racing a
 * predecessor that is still binding reports its real address rather than
 * failing on the sentinel. URL preference order:
 *
 * 1. lock v2 `url` when the holder advertises the `ui` capability — the
 *    canonical one-URL contract (the same record Desktop attaches through);
 * 2. the server's own `url`/port — API+MCP only (a `--only server` boot), but
 *    still the right address.
 *
 * All time + IO deps injected (precedent #13b) so tests drive every branch
 * with a virtual clock and no filesystem.
 */
export async function resolveServerReuse(
  deps: ResolveServerReuseDeps,
): Promise<ServerReuseInfo | null> {
  const deadline = deps.now() + deps.timeoutMs;
  let lock = deps.readServerLock();
  while (lock !== null && lock.draining !== true && lock.port <= 0 && deps.now() < deadline) {
    await deps.sleep(deps.pollIntervalMs);
    lock = deps.readServerLock();
  }
  if (lock === null || lock.draining === true || lock.port <= 0) return null;
  if (lockAdvertisesUi(lock) && lock.url !== undefined) {
    return { url: lock.url, kind: lock.kind, pid: lock.pid, servesUi: true };
  }
  return {
    url: lock.url ?? `http://${DEFAULT_SERVER_HOST}:${lock.port}`,
    kind: lock.kind,
    pid: lock.pid,
    servesUi: false,
  };
}

/**
 * The reuse notice a second `ok start` prints before exiting 0. Pure so the
 * copy (and the holder-kind variants) are unit-tested. `kind: 'interactive'`
 * covers BOTH terminal `ok start` and desktop-spawned servers (every direct
 * boot stamps it), so it gets the neutral copy — only `mcp-spawned` is a
 * genuinely distinguishable holder.
 */
export function formatServerReuseNotice(info: ServerReuseInfo): string[] {
  const holder =
    info.kind === 'mcp-spawned'
      ? 'An MCP-spawned OpenKnowledge server is already running on this project'
      : 'OpenKnowledge is already running on this project';
  return [
    `${holder} (pid ${info.pid}).`,
    `  ${info.url}`,
    'Leaving it running — run `ok stop` first if you want a fresh server.',
  ];
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
    // `.ok/local/` — the same anchor the server writes (join(cwd, OK_DIR)
    // pointed one level too shallow and always fell back to the generic copy).
    const meta = serverModule.readServerLock(serverModule.resolveLockDir(cwd));
    if (!meta) {
      return 'OpenKnowledge server is already running on this project — check `ok status` or `ok stop`.';
    }
    // NOTE: `kind: 'interactive'` covers both terminal and desktop servers,
    // so it takes the generic fallthrough below — a "desktop is running"
    // claim here would be wrong for every terminal-started holder.
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
    .description('Start the OpenKnowledge server (UI + API + MCP + collab on one port)')
    .option('-p, --port <port>', 'Server port', undefined)
    .option(
      '--bind <address>',
      'Bind address (repeatable; default 127.0.0.1 — loopback only)',
      (value: string, prev: string[] | undefined) => [...(prev ?? []), value],
    )
    .option(
      '--no-open-browser',
      'Do not open the browser after start (interactive loopback starts open it by default)',
    )
    .option(
      '--only <module>',
      "Serve one module: 'server' (API + MCP only, no shell or browser)",
      parseOnlyModule,
    )
    .option(
      '--idle-shutdown <duration>',
      "Shut the server down after this long with no connected clients ('off', or a duration like 90s, 30m, 2h; default 30m)",
      parseIdleShutdownFlag,
    )
    .option('--mode <mode>', "Force dispatch mode: 'browser' or 'app'", parseStartMode)
    .option(
      '--serve-content-assets',
      'Serve content assets from this server (now the default; kept for compatibility)',
    )
    .option('--react-shell-dist-dir <path>', 'Serve React shell from <path>')
    // Hidden from --help: both are the desktop→child spawn ABI, not a user
    // surface — the supported way to open one file is `ok <file>`. They stay
    // functional (and validated) for parent spawners and anyone who knows.
    .addOption(
      new Option(
        '--single-file <path>',
        'No-project ephemeral single-file mode: scope the server to one markdown file (git + MCP off)',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--project-dir <dir>',
        'Throwaway project root for --single-file (where ephemeral .ok/ state lives)',
      ).hideHelp(),
    )
    .option(
      '--external-url <url>',
      'Canonical external origin clients dial (sets server.externalUrl for this run) — its host joins the Host/Origin allowlists (CORS + external-Host admission). External exposure additionally requires consent (OK_ALLOW_EXTERNAL=1 or server.allowExternal).',
      parseExternalUrlFlag,
    )
    .action(async (opts: StartCommandOptions) => {
      const config = getConfig();

      // `--only server` promises "no UI module" — an explicit shell dir
      // contradicts it. Fail loud rather than pick a winner silently.
      if (opts.only === 'server' && opts.reactShellDistDir !== undefined) {
        process.stderr.write(
          "error: option '--only server' cannot be combined with '--react-shell-dist-dir'\n",
        );
        process.exit(2);
      }

      // `--project-dir` names the throwaway root of the ephemeral single-file
      // shape and means nothing outside it. Fail loud rather than silently
      // ignore — a user pointing it at a real project must not believe the
      // server is rooted there.
      if (opts.projectDir !== undefined && opts.singleFile === undefined) {
        process.stderr.write("error: option '--project-dir' requires '--single-file'\n");
        process.exit(2);
      }

      // `--mode=app` shortcuts the server boot and hands off to the
      // desktop app.
      if (opts.mode === 'app') {
        // Non-mode start flags are silently ignored under --mode=app,
        // with a debug-level diagnostic so a confused user / CI script
        // can grep for it without crashing.
        const ignored: string[] = [];
        if (opts.port !== undefined) ignored.push('--port');
        if (opts.bind !== undefined) ignored.push('--bind');
        if (opts.only !== undefined) ignored.push('--only');
        if (opts.idleShutdown !== undefined) ignored.push('--idle-shutdown');
        if (opts.openBrowser === false) ignored.push('--no-open-browser');
        if (opts.externalUrl !== undefined) ignored.push('--external-url');
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
          launchDesktop({ spawn: nativeSpawn }, decision);
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
