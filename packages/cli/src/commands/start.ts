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
 * re-point shipped stable. `--only server` suppresses the UI module entirely;
 * `--only ui` (with `--server-url`) runs just the shell-serving proxy — a
 * deprecated split-mode that retires together with ui.lock.
 *
 * The Commander action is a thin wrapper around `bootStartServer` — that
 * boot function returns a `BootedStartServer` handle (`{httpServer, destroy,
 * port, ready, ...}`) so integration tests can drive the same composed boot
 * path the CLI uses, without process-level signal coupling.
 */
import { spawn as nativeSpawn } from 'node:child_process';
import { existsSync as fsExistsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { basename, resolve as pathResolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  applyConfigOverlay,
  DEFAULT_REMOTE_PORT,
  DEFAULT_SERVER_HOST,
  type EnvConfigLayer,
  EnvVarError,
  IDLE_SHUTDOWN_DURATION_RE,
  idleShutdownToMs,
  isLoopbackOnlyBind,
  resolveEnvConfigLayer,
  resolveServerRuntimeConfig,
  type ServerRuntimeConfig,
} from '@inkeep/open-knowledge-core';
import {
  type BootedServer,
  type Config,
  isProjectRoot,
  type PinoLogger,
  prepareSingleFileOpen,
} from '@inkeep/open-knowledge-server';
import { Command, InvalidArgumentError, Option } from 'commander';
import { makeLazyEmbeddingsKeyStore } from '../auth/embeddings-key-store.ts';
import { detectGh } from '../auth/gh-detect.ts';
import { makeLazyProbeTokenStore } from '../auth/token-store.ts';
import { PACKAGE_VERSION } from '../constants.ts';
import { probeOwnManagedEditorMcpEntry } from './acp-harness-probe.ts';
import {
  createRealDetectDeps,
  detectDesktop,
  launchDesktop,
  notFoundMessage,
} from './desktop-dispatch.ts';

/** 30 minutes — default threshold. */
const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Resolve a single bind host with `--bind` flag > deprecated `--host` alias >
 * `HOST` env > application default precedence. Pure helper — no side effects,
 * no `process.env` access inside (env passed in) so tests can pin all
 * branches. Used by the ephemeral single-file path; `ok start` proper
 * resolves the full bind LIST (config/env layers included) inline.
 */
export function resolveHost(
  opts: { host?: string; bind?: string[] },
  env: { HOST?: string | undefined; [key: string]: string | undefined },
): string {
  return opts.bind?.[0] ?? opts.host ?? env.HOST ?? DEFAULT_SERVER_HOST;
}

/** Modules selectable via `--only` — explicit operator module selection. */
export type OnlyModule = 'ui' | 'server';

/**
 * Validator for Commander's `--only` parser. Throws `InvalidArgumentError`
 * for anything outside the documented enum, which Commander converts into a
 * non-zero exit + usage.
 */
export function parseOnlyModule(value: string): OnlyModule {
  if (value === 'ui' || value === 'server') return value;
  throw new InvalidArgumentError("--only must be 'ui' or 'server'");
}

/**
 * Resolve the bundled React shell `dist` directory — published `dist/public`
 * first, then the monorepo `app/dist`. One resolver shared by plain
 * `ok start`, remote mode, and the ephemeral single-file browser fallback so
 * dev and published builds can never disagree on where the shell lives.
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
 * Decide which React-shell directory the composed server serves — the Wave 3
 * default-flip decision, pure so every branch is unit-tested:
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
 * (Heroku/Railway); when it — and neither `--bind`/`--host` nor `OK_BIND` —
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
 * non-local stays quiet. Pure so the whole decision table is unit-tested:
 *
 * Guard order matters. The "nothing to open" and "explicit no" checks run
 * BEFORE the deprecated `--open` force-open, so `--open` can override the TTY
 * and loopback gates (its pre-flip contract) but can never pop a dead tab at
 * a shell-less server or fight an explicit `--no-open-browser`:
 *
 * - `--no-open-browser` always suppresses, even against `--open`;
 * - remote mode, ephemeral single-file (owns its own open flow), `--only
 *   server`, and a start that ended up serving no shell never open;
 * - `--open` (deprecated) then forces open, preserving its pre-flip contract
 *   for scripts that relied on it in non-TTY contexts;
 * - otherwise: open iff the bind is loopback AND stdout is a TTY (a spawned
 *   or CI invocation must not pop a browser). An EXPLICIT
 *   `server.openBrowser: true` / `OK_OPEN_BROWSER=1` (`explicitOn`) lifts
 *   the loopback-bind condition — the operator asked by name — but keeps
 *   the TTY gate so a container or spawned start still never pops one.
 */
export function shouldOpenBrowser(input: {
  openBrowser: boolean;
  explicitOn: boolean;
  legacyOpen: boolean;
  host: string;
  isTTY: boolean;
  remoteEnabled: boolean;
  ephemeral: boolean;
  only: OnlyModule | undefined;
  servesUi: boolean;
}): boolean {
  if (!input.openBrowser) return false;
  if (input.remoteEnabled || input.ephemeral || input.only === 'server') return false;
  if (!input.servesUi) return false;
  if (input.legacyOpen) return true;
  return (input.explicitOn || isLoopbackHost(input.host)) && input.isTTY;
}

/**
 * Bind-family guard for remote mode. Tunnel agents (ngrok, cloudflared,
 * tailscaled, …) proxy to an IPv4 loopback target (`127.0.0.1:<port>`), so an
 * IPv6-only bind (`::`, `::1`, or `localhost` resolving to `::1` first)
 * leaves the tunnel dialing a port nobody answers on — hit in practice during
 * the MVP. When remote access is enabled and the resolved host is one of
 * those shapes, coerce to `127.0.0.1` and tell the operator. Pure — returns
 * the corrected host and whether a coercion happened; caller logs.
 */
export function coerceRemoteBindHost(
  host: string,
  remoteEnabled: boolean,
): { host: string; coerced: boolean } {
  if (!remoteEnabled) return { host, coerced: false };
  if (
    host === '::' ||
    host === '::1' ||
    host === '[::1]' ||
    host === 'localhost' ||
    // 0.0.0.0 binds every interface; in remote mode the tunnel agent only
    // needs loopback, and an all-interfaces bind would let a LAN peer reach
    // the admitted surface directly, bypassing the tunnel's edge auth.
    host === '0.0.0.0'
  ) {
    return { host: '127.0.0.1', coerced: true };
  }
  return { host, coerced: false };
}

/** The `server.*` keys `--remote` expands into — nothing beyond the ratified surface. */
interface RemoteAliasServerOverlay {
  externalUrl: string;
  allowExternal: true;
  idleShutdown: 'off';
}

export type RemoteAliasExpansion =
  | { ok: true; url: string; serverOverlay: RemoteAliasServerOverlay }
  | { ok: false; errorMessage: string };

/**
 * Scope the alias's self-consent to the topology it promises: a loopback
 * bind where the tunnel's edge auth is the only ingress. A non-loopback bind
 * (a tailnet/LAN address from `server.bind`, `OK_BIND`, `HOST`, or a `--bind`
 * shape `coerceRemoteBindHost` does not recognize) is reachable AROUND the
 * tunnel, so `--remote` must not consent to it on the operator's behalf —
 * without this, the exposure interlock that refused `--remote` + a
 * non-loopback bind before the alias would be silently satisfied. Dropping
 * `allowExternal` here lets the interlock refuse exactly as before;
 * `OK_ALLOW_EXTERNAL=1` remains the sanctioned override.
 */
export function scopeRemoteAliasConsentToBind(
  serverOverlay: RemoteAliasServerOverlay,
  bindList: readonly string[],
): { externalUrl: string; idleShutdown: 'off'; allowExternal?: true } {
  if (isLoopbackOnlyBind(bindList)) return serverOverlay;
  return { externalUrl: serverOverlay.externalUrl, idleShutdown: serverOverlay.idleShutdown };
}

/**
 * `--remote [url]` is a deprecated thin alias over the ratified `server.*`
 * networking keys: it expands to `server.externalUrl` = the tunnel url (its
 * host joins the Host/Origin allowlists), a loopback bind (tunnels proxy to
 * `127.0.0.1` — the deployer's tunnel agent covers ingress, see
 * `coerceRemoteBindHost`), and `server.allowExternal` consent, which
 * satisfies the exposure interlock and the forwarded-header tripwire. Plus
 * `server.idleShutdown: 'off'`: remote MCP sessions arrive as plain HTTP,
 * and the idle timer counts /collab WS clients only — it would tear the
 * server down under a live remote client. Networking-only — the alias
 * carries no auth semantics; restricting who reaches the URL stays the
 * tunnel's job (edge auth).
 *
 * Returns `null` when the flag is absent. `ok: false` carries the exit-78
 * message: a missing url is unusable, and the legacy https-only rule is kept
 * through the deprecation window (a tunnel URL over plain http would be
 * credentials-in-the-clear).
 */
export function expandRemoteAlias(
  remoteFlag: string | boolean | undefined,
  configRemoteUrl: string | undefined,
): RemoteAliasExpansion | null {
  if (remoteFlag === undefined || remoteFlag === false) return null;
  const url = typeof remoteFlag === 'string' ? remoteFlag : configRemoteUrl;
  if (url === undefined || url === '') {
    return {
      ok: false,
      errorMessage:
        '--remote requires a public tunnel URL — pass it (`ok start --remote https://<your-tunnel-host>`) or set remote.url in .ok/config.yml.',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, errorMessage: `remote.url is not a valid URL: ${url}` };
  }
  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      errorMessage: `remote.url must be https — it is the public tunnel URL remote clients connect to (got: ${url})`,
    };
  }
  const normalizedUrl = url.replace(/\/+$/, '');
  return {
    ok: true,
    url: normalizedUrl,
    serverOverlay: { externalUrl: normalizedUrl, allowExternal: true, idleShutdown: 'off' },
  };
}

/**
 * Validator shared by the `--external-url` parser and its deprecated
 * `--public-url` spelling — the flag-layer setter for `server.externalUrl`,
 * matching the schema leaf's http(s)-origin shape so a flag value can never
 * smuggle in what the config file would reject. `flagName` keeps the error
 * text naming the flag the user actually typed.
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

/**
 * The flag-layer external-URL fold: `--external-url` wins, the deprecated
 * `--public-url` spelling fills in when it is the only one given (the two
 * flags cannot legally co-occur — the action guard exits 2 — so the `??` is
 * precedence bookkeeping, not conflict resolution). Extracted so a test pins
 * that the deprecated flag keeps setting `server.externalUrl` through its
 * removal window: dropping the fallback would silently strand `--public-url`
 * operators on `externalUrl: undefined` (no CORS/Host admission, no issued
 * URLs) with no parse error to signal it.
 */
export function resolveFlagExternalUrl(
  opts: Pick<StartCommandOptions, 'externalUrl' | 'publicUrl'>,
): string | undefined {
  return opts.externalUrl ?? opts.publicUrl;
}

/** Parser for the deprecated `--public-url` alias of `--external-url`. */
export function parsePublicUrlFlag(value: string): string {
  return parseHttpOriginFlag('--public-url', value);
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
 * Resolve the collab server's port from the three sources, for `runStartCommand`.
 * An explicit `--port` always wins. Otherwise env `PORT` is dropped when
 * remote access is enabled, because PaaS platforms (Railway, Fly, Render)
 * inject `PORT` for their own edge proxy — honoring it would silently move
 * the server off the stable `remote.port` the tunnel's port mapping targets,
 * leaving the tunnel dialing a dead port. Pure so the suppression rule is
 * tested directly.
 */
export function resolveCollabPort(
  portFromCli: number | undefined,
  portFromEnv: number | undefined,
  remoteEnabled = false,
): number | undefined {
  return portFromCli ?? (remoteEnabled ? undefined : portFromEnv);
}

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
   * Server bind host. Source ordering at the call site is `--host` flag →
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
   * project > user), threaded to `bootServer` so issued URLs and the
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
  const { basename, dirname } = await import('node:path');
  const { bootServer, getLogger, resolveContentDir, resolveLockDir, waitForServerLockDrain } =
    await import('@inkeep/open-knowledge-server');

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
  {
    const drainLockDir = resolveLockDir(ephemeral ? ephemeralProjectDir : cwd);
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
    // ACP threads skip injecting the `open-knowledge` MCP server when the
    // agent's own harness already loads OK's managed editor-config entry.
    probeHarnessManagedMcpEntry: (editorId, agentCwd) =>
      probeOwnManagedEditorMcpEntry(editorId, agentCwd),
    // CLI-specific opt-ins
    idleShutdownMs: idleThresholdMs,
    ...(opts.serverRuntime !== undefined ? { serverRuntime: opts.serverRuntime } : {}),
    ...(opts.bind !== undefined ? { bind: opts.bind } : {}),
    skipAutoInit: true, // Guard already ran above; no scaffold fn to pass
    idleShutdownHandler: (destroyServer) => {
      const handler = destroyServer;
      const reaped = ephemeral ? withEphemeralTempDirReap(handler, ephemeralProjectDir) : handler;
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

  return {
    httpServer: booted.httpServer,
    destroy: booted.destroy,
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
  /** From the deprecated `-H, --host` alias of `--bind`. */
  host?: string;
  /** From deprecated `--open`: force-open the browser (pre-flip contract, honored even non-TTY). */
  open?: boolean;
  /**
   * From `--no-open-browser` (Commander negation: absent → `true`). Interactive
   * loopback starts open the browser by default; this is the suppression
   * direction — see `shouldOpenBrowser` for the full decision table.
   */
  openBrowser?: boolean;
  /**
   * From `--only <ui|server>`: explicit module selection. `'server'` boots the
   * project server with no UI module (no shell, no sibling); `'ui'` is handled
   * in the action (delegates to the UI proxy with `--server-url`) and never
   * reaches `runStartCommand`.
   */
  only?: OnlyModule;
  /** From `--server-url <url>`: where the `--only ui` split-mode UI finds its project server. */
  serverUrl?: string;
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
  /**
   * From `--remote [url]`: deprecated alias over the `server.*` keys — see
   * `expandRemoteAlias`. `true` when the flag is bare (url comes from
   * `remote.url` in config); a string when the url is supplied inline (used
   * for this run, not persisted). Absent → loopback-only, regardless of any
   * `remote.url` in config.
   */
  remote?: string | boolean;
  /** From `--external-url <url>`: flag-layer `server.externalUrl` for this run. */
  externalUrl?: string;
  /** From the deprecated `--public-url` alias of `--external-url`. */
  publicUrl?: string;
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
  // Remote access is an explicit `--remote [url]` opt-in. A `remote.url` left
  // in `.ok/config.yml` does NOT arm it by itself — the flag decides; the
  // config url fills in when the flag is bare, and a flag-supplied url wins
  // for this run without persisting. The flag is a deprecated thin alias over
  // the ratified `server.*` keys — `expandRemoteAlias` holds the expansion.
  const remoteFlagSet = opts.remote !== undefined && opts.remote !== false;

  // Set the process title as early as possible so Activity Monitor and
  // `ps -ax | grep open-knowledge-server` show each running server by
  // project name. This is the primary user-facing surface for orphan
  // management — there's no in-app "Stop server"
  // action; the OS process list is the discovery path.
  process.title = deriveServerProcessTitle(cwd);

  // Deprecation notice first, even when the expansion below refuses — the
  // operator should learn the successor spelling from the same run that
  // errors. Networking-only alias; removal ships separately after a soak.
  if (remoteFlagSet) {
    console.warn(
      warning(
        '--remote is deprecated — use `OK_IDLE_SHUTDOWN=off OK_ALLOW_EXTERNAL=1 ok start --external-url <url>` instead (add --bind to serve a non-loopback address; keep OK_IDLE_SHUTDOWN=off — the idle timer only counts WS clients and would tear the server down under a live remote MCP client). The flag now just expands to those server.* keys and will be removed in a later release.',
      ),
    );
  }

  // Same ordering contract as the --remote notice above: the rename notices
  // print even when a later step refuses, so the operator learns the
  // successor spelling from the same run.
  if (opts.publicUrl !== undefined) {
    console.warn(
      warning(
        '--public-url is deprecated — use --external-url <url> (same value and semantics; the key was renamed to server.externalUrl). The old spelling will be removed in a later release.',
      ),
    );
  }

  // Config-file rename notice, keyed off the FILE layers (before the env/flag
  // overlay — those spellings write the successor key and warn on their own,
  // and a masking override doesn't make the stale file key any less stale).
  if (resolveServerRuntimeConfig(config).externalUrlFromDeprecatedKey) {
    // "Use X instead", not "rename it": in a committed shared config, keeping
    // BOTH keys is the sanctioned mixed-version state — older app versions
    // read only server.publicUrl and silently ignore server.externalUrl, so
    // a literal rename would 403 collaborators who have not upgraded.
    console.warn(
      warning(
        '[config] server.publicUrl is deprecated — use server.externalUrl instead (same value and semantics). If this config is committed and shared, keep both keys until every collaborator has upgraded — older versions read only server.publicUrl; see https://openknowledge.ai/docs/reference/configuration. The old key will be removed in a later release.',
      ),
    );
  }

  // Fail loud BEFORE booting: --remote with no url anywhere (or a non-https
  // url) is unusable, and the error message is the fix instruction.
  const aliasResult = expandRemoteAlias(opts.remote, config.remote?.url);
  if (aliasResult !== null && !aliasResult.ok) {
    console.error(error(aliasResult.errorMessage));
    process.exit(78);
  }
  const remoteAlias = aliasResult?.ok ? aliasResult : null;
  const remoteEnabled = remoteAlias !== null;

  // The trust-the-tunnel warning. Deliberately unmissable: with --remote there
  // is NO server-side authentication — access control is entirely the
  // tunnel's job (edge auth), and every admitted caller has the full owner
  // surface. Printed on every remote start so the trade is never implicit.
  if (remoteAlias !== null) {
    console.warn(
      warning(
        [
          '',
          '⚠  REMOTE ACCESS ENABLED — no server-side authentication.',
          `   Anyone who can reach ${remoteAlias.url} has FULL control of this`,
          '   knowledge base, including sync, publishing, credentials, and local operations.',
          '   Restrict who can reach it at the tunnel: ngrok OAuth, Cloudflare Access,',
          '   Tailscale ACLs, or equivalent edge auth.',
          '',
        ].join('\n'),
      ),
    );
  }

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

  // Bind precedence: --bind / deprecated --host flags > ratified OK_BIND >
  // legacy HOST env > server.bind file layer > loopback default. The resolved
  // LIST is what the derived defaults key off (openBrowser/idleShutdown
  // derive from loopback-only-ness); the listener binds every entry in the
  // list (multi-address bind), each on the same port.
  const okBindSet = envLayer.overrides.some((o) => o.envVar === 'OK_BIND');
  const flagBind =
    opts.bind !== undefined && opts.bind.length > 0
      ? opts.bind
      : opts.host !== undefined
        ? [opts.host]
        : undefined;
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

  const resolvedHost = requestedBind[0] ?? DEFAULT_SERVER_HOST;
  const hostCoercion = coerceRemoteBindHost(resolvedHost, remoteEnabled);
  if (hostCoercion.coerced) {
    console.warn(
      `remote access is enabled and ${resolvedHost} is not an IPv4 loopback bind — tunnels proxy to 127.0.0.1, so binding ${resolvedHost} would leave the tunnel dialing a dead port. Using 127.0.0.1.`,
    );
  }
  const host = hostCoercion.host;
  // The EFFECTIVE bind list — remote mode collapses to the coerced loopback
  // host (the tunnel is the only ingress there), so the interlock and the
  // ingress policy see what the server actually binds, not the pre-coercion
  // request. Without this, `HOST=0.0.0.0 ok start --remote` coerces to
  // loopback yet still trips ExposureConsentError off the uncoerced list.
  const bindList = remoteEnabled ? [host] : requestedBind;
  // The flag-layer overlay, applied ABOVE the env layer: the resolved bind
  // list, the `--remote` alias expansion (externalUrl + allowExternal +
  // idleShutdown 'off' — the SAME server.* resolution path any other exposure
  // route uses), and `--external-url` (or its deprecated `--public-url`
  // spelling — both write the successor key so the flag layer keeps its
  // precedence over env and file layers). Nothing here is remote-specific
  // machinery; the alias is only these keys. Self-consent is loopback-scoped
  // (see scopeRemoteAliasConsentToBind) — a non-loopback bind under --remote
  // still needs explicit consent, so the interlock refusal below matches the
  // pre-alias behavior.
  const aliasOverlay =
    remoteAlias !== null ? scopeRemoteAliasConsentToBind(remoteAlias.serverOverlay, bindList) : {};
  if (remoteAlias !== null && !('allowExternal' in aliasOverlay)) {
    console.warn(
      warning(
        `--remote does not consent to exposing a non-loopback bind (${bindList.join(', ')}) — the tunnel is the only ingress the alias vouches for. Consent explicitly with OK_ALLOW_EXTERNAL=1 (or server.allowExternal in .ok/local/config.yml), or drop the non-loopback bind.`,
      ),
    );
  }
  const flagExternalUrl = resolveFlagExternalUrl(opts);
  const runtime: ServerRuntimeConfig = resolveServerRuntimeConfig(
    applyConfigOverlay(envConfig, {
      server: {
        bind: bindList,
        ...aliasOverlay,
        ...(flagExternalUrl !== undefined ? { externalUrl: flagExternalUrl } : {}),
      },
    }) as Config,
  );

  // The consent warning, sibling to the --remote banner above. `allowExternal`
  // is the sanctioned relaxation, but its blast radius is easy to under-read:
  // it exposes not just the editor/collab/API surface but the local-op owner
  // surface (clone, GitHub sign-in, PAT storage, repo spawn) to every external
  // peer, with NO server-side auth. Fire whenever consent is armed AND there is
  // a real exposure vector — a non-loopback bind (direct) or a declared
  // externalUrl (a same-host reverse proxy forwards to a loopback bind). The
  // --remote flow prints its own warning, so skip the duplicate there.
  if (!remoteEnabled && runtime.allowExternal && (!runtime.loopbackOnly || runtime.externalUrl)) {
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
  // An explicit --port wins everywhere; in remote mode the config port fills
  // the default slot and env PORT is suppressed (see resolveCollabPort).
  // A stable port matters in remote mode because the tailscale serve/funnel
  // mapping names a fixed target port — a kernel-assigned ephemeral port would
  // break the tunnel on every restart.
  // File-layer ports, split by consumer:
  //  - `remotePort` follows the resolver's `server.port ?? remote.port` alias
  //    — remote mode wants the stable tunnel-target port from either key.
  //  - `localPort` is the SUCCESSOR key ONLY. A plain local start must not
  //    inherit a dormant `remote.port` (set long ago for tunnel use); doing so
  //    pins every local boot to that fixed port instead of a free dynamic one,
  //    and two projects both carrying `remote.port` could never run at once.
  const remotePort = resolveServerRuntimeConfig(config).port;
  const localPort = config.server?.port;
  if (remoteEnabled && portFromCli === undefined && portFromEnv !== undefined) {
    console.warn(
      `remote access is enabled — ignoring env PORT=${process.env.PORT}; the tunnel's port mapping targets the stable remote port (${remotePort ?? DEFAULT_REMOTE_PORT}). Pass --port to override deliberately.`,
    );
  }
  const port =
    resolveCollabPort(portFromCli, portFromEnv, remoteEnabled) ??
    (remoteEnabled ? (remotePort ?? DEFAULT_REMOTE_PORT) : localPort);

  // The default composition serves the SPA from the server's own port (`/` =
  // UI, `/api`, `/mcp`, `/collab` — one listener, one origin).
  // `resolveStartShellDir` holds the decision table (explicit dir wins;
  // `--only server` opts out; everything else — remote included — serves the
  // shell by default). A missing bundle degrades to API/MCP-only with a
  // warning rather than failing the start.
  const shell = resolveStartShellDir({
    explicitDir: opts.reactShellDistDir,
    only: opts.only,
    findBundledDir: resolveBundledReactShellDir,
  });
  const reactShellDistDir = shell.dir;
  if (shell.missingBundle) {
    console.warn(
      remoteEnabled
        ? 'remote access: bundled web UI not found — serving /mcp and /api only over the tunnel.'
        : 'bundled web UI not found — serving /api and /mcp only. Reinstall @inkeep/open-knowledge, or build packages/app in a source checkout.',
    );
  }

  let booted: BootedStartServer;
  try {
    booted = await bootStartServer({
      config,
      cwd,
      host,
      port,
      // Full bind list for the multi-listener bind — already collapsed to the
      // coerced loopback host in remote mode (see `bindList` above).
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
      // through Commander on purpose — see parseIdleShutdownFlag. Under
      // --remote the alias overlay pins 'off' and the flag is ignored — the
      // legacy remote flow always disabled the idle timer, and a remote MCP
      // client is plain HTTP the /collab-counting timer can't see.
      idleThresholdMs: idleShutdownToMs(
        (remoteEnabled ? undefined : opts.idleShutdown) ?? runtime.idleShutdown,
      ),
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
          readUiLock: () => serverModule.readUiLock(lockDir),
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
      // banner URL is the full editor (suppress with --no-open-browser; the
      // deprecated --open force-opens). Decision table: `shouldOpenBrowser`.
      const openDecision = shouldOpenBrowser({
        // Flag suppression wins; otherwise the resolver's openBrowser covers
        // OK_OPEN_BROWSER, the config leaf, and the bind-derived default.
        openBrowser: opts.openBrowser !== false && runtime.openBrowser,
        explicitOn: opts.openBrowser !== false && envConfig.server?.openBrowser === true,
        legacyOpen: opts.open === true,
        host,
        isTTY: process.stdout.isTTY === true,
        remoteEnabled,
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
  readUiLock: () => { pid: number; port: number; url?: string } | null;
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
 * 2. a live `ui.lock` advertisement — the sibling topology (an older server
 *    or `--only server`), where the browser-facing origin is the UI process;
 * 3. the server's own `url`/port — API+MCP only, but still the right address.
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
  if (lock.capabilities?.includes('ui') === true && lock.url !== undefined) {
    return { url: lock.url, kind: lock.kind, pid: lock.pid, servesUi: true };
  }
  const uiLock = deps.readUiLock();
  if (uiLock !== null && uiLock.port > 0) {
    // Prefer the ui.lock's own advertised url (symmetric with the server.lock
    // branch above) — a UI bound to `::1` on a host where `localhost` resolves
    // to `127.0.0.1` would otherwise be reported at the wrong address.
    return {
      url: uiLock.url ?? `http://localhost:${uiLock.port}`,
      kind: lock.kind,
      pid: lock.pid,
      servesUi: false,
    };
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
    // Deprecated alias of --bind — kept working for the skew window, hidden
    // from --help so new scripts reach for the locked name.
    .addOption(new Option('-H, --host <host>', 'Deprecated alias of --bind').hideHelp())
    .option(
      '--no-open-browser',
      'Do not open the browser after start (interactive loopback starts open it by default)',
    )
    // Deprecated: pre-flip opt-in, now the default for interactive loopback
    // starts. Kept as a force-open for scripts that relied on it (it opens
    // even without a TTY). Hidden from --help.
    .addOption(new Option('--open', 'Deprecated: force-open the browser after start').hideHelp())
    .option(
      '--only <module>',
      "Serve one module: 'server' (API + MCP only, no shell or browser) or 'ui' (shell + proxy only; requires --server-url)",
      parseOnlyModule,
    )
    .option(
      '--server-url <url>',
      'Project-server URL the --only ui process proxies to (e.g. http://127.0.0.1:24550)',
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
    .option(
      '--single-file <path>',
      'No-project ephemeral single-file mode: scope the server to one markdown file (git + MCP off)',
    )
    .option(
      '--project-dir <dir>',
      'Throwaway project root for --single-file (where ephemeral .ok/ state lives)',
    )
    .option(
      '--external-url <url>',
      'Canonical external origin clients dial (sets server.externalUrl for this run) — its host joins the Host/Origin allowlists and issued URLs. External exposure additionally requires consent (OK_ALLOW_EXTERNAL=1 or server.allowExternal).',
      parseExternalUrlFlag,
    )
    .option(
      '--public-url <url>',
      'Deprecated alias of --external-url (the former name of that flag) — same value and semantics.',
      parsePublicUrlFlag,
    )
    .option(
      '--remote [url]',
      'Deprecated alias: expands to --external-url <url> + OK_ALLOW_EXTERNAL consent on a loopback bind. Serves through a tunnel with NO server-side auth (anyone who can reach the URL has full control — restrict access at the tunnel with edge auth). Bare --remote uses remote.url from .ok/config.yml; --remote <url> supplies it for this run.',
    )
    .action(async (opts: StartCommandOptions) => {
      const config = getConfig();

      // `--server-url` only means something to the --only ui proxy.
      if (opts.serverUrl !== undefined && opts.only !== 'ui') {
        process.stderr.write("error: option '--server-url' requires '--only ui'\n");
        process.exit(2);
      }

      // `--external-url` and its deprecated `--public-url` spelling are the
      // same flag under two names — combining them would make one silently
      // win. Fail loud; pass one.
      if (opts.externalUrl !== undefined && opts.publicUrl !== undefined) {
        process.stderr.write(
          "error: option '--public-url' cannot be combined with '--external-url' (--public-url is a deprecated alias of --external-url)\n",
        );
        process.exit(2);
      }

      // `--remote` IS an `--external-url` (plus consent) — combining them
      // would make one silently win. Fail loud; pass one.
      if (
        (opts.externalUrl !== undefined || opts.publicUrl !== undefined) &&
        opts.remote !== undefined &&
        opts.remote !== false
      ) {
        const conflicting = opts.externalUrl !== undefined ? '--external-url' : '--public-url';
        process.stderr.write(
          `error: option '--remote' cannot be combined with '${conflicting}' (--remote is a deprecated alias that sets server.externalUrl)\n`,
        );
        process.exit(2);
      }

      // Ephemeral single-file mode has no project and no consented root — the
      // legacy remote flow refused to arm there (while still printing an
      // "enabled" banner). Now that --remote expands into real exposure
      // consent, refuse the combination loudly instead of exposing a
      // throwaway root.
      if (opts.singleFile !== undefined && opts.remote !== undefined && opts.remote !== false) {
        process.stderr.write(
          "error: option '--single-file' cannot be combined with '--remote' — ephemeral single-file mode has no project and no consented root to serve remotely\n",
        );
        process.exit(2);
      }

      // `--only server` promises "no UI module" — an explicit shell dir
      // contradicts it. Fail loud rather than pick a winner silently.
      if (opts.only === 'server' && opts.reactShellDistDir !== undefined) {
        process.stderr.write(
          "error: option '--only server' cannot be combined with '--react-shell-dist-dir'\n",
        );
        process.exit(2);
      }

      // `--only ui`: run just the shell-serving proxy against an explicit
      // upstream — the operator split-mode replacement for the removed
      // `ok ui` (which discovered its upstream via server.lock instead).
      if (opts.only === 'ui') {
        // Deprecation notice FIRST, before any refusal below — the operator
        // should learn the successor spelling from the same run that errors
        // (mirrors the --remote notice ordering). Stderr so stdout stays
        // parseable for callers that scrape the "listening on" line. The
        // split-mode proxy retires together with ui.lock in a later release.
        {
          const { warning } = await import('../ui/colors.ts');
          console.error(
            warning(
              '[start] `--only ui` is deprecated — plain `ok start` serves the editor UI, API, and MCP on one port. The split-mode proxy will be removed in a future release.',
            ),
          );
        }
        if (opts.serverUrl === undefined) {
          process.stderr.write(
            "error: '--only ui' requires '--server-url <url>' (where the project server runs)\n",
          );
          process.exit(2);
        }
        // `--only ui` runs the proxy in-process and returns below, before the
        // --mode app handoff and before runStartCommand reads --remote — so
        // either combination would silently drop a flag. Reject loudly.
        if (opts.mode === 'app') {
          process.stderr.write("error: option '--only ui' cannot be combined with '--mode app'\n");
          process.exit(2);
        }
        if (opts.remote !== undefined && opts.remote !== false) {
          process.stderr.write("error: option '--only ui' cannot be combined with '--remote'\n");
          process.exit(2);
        }
        const { runUiCommand } = await import('./ui.ts');
        await runUiCommand(config, {
          ...(opts.port !== undefined ? { port: String(opts.port) } : {}),
          ...(opts.bind?.[0] !== undefined
            ? { host: opts.bind[0] }
            : opts.host !== undefined
              ? { host: opts.host }
              : {}),
          upstreamUrl: opts.serverUrl,
        });
        return;
      }

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
        if (opts.bind !== undefined) ignored.push('--bind');
        if (opts.host !== undefined) ignored.push('--host');
        if (opts.only !== undefined) ignored.push('--only');
        if (opts.serverUrl !== undefined) ignored.push('--server-url');
        if (opts.idleShutdown !== undefined) ignored.push('--idle-shutdown');
        if (opts.openBrowser === false) ignored.push('--no-open-browser');
        if (opts.externalUrl !== undefined) ignored.push('--external-url');
        if (opts.publicUrl !== undefined) ignored.push('--public-url');
        if (opts.remote !== undefined && opts.remote !== false) ignored.push('--remote');
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
