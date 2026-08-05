/**
 * Start a Slidev dev server for a deck and confirm it is actually serving
 * before anyone points a window at it.
 *
 * OK never renders slides — Slidev does, in a process we spawn. The one thing
 * that can go wrong invisibly is opening a window onto a port that is not yet
 * (or never will be) a live Slidev server: the spawn can fail, the server can
 * die mid-boot, it can hang, or the port can answer with something that is not
 * a Slidev deck. `startSlidevServer` collapses all of that into a single
 * verdict, and guarantees the spawned process is reaped on every failure path
 * so a rejected start never leaks a server or its port.
 *
 * Readiness copies VS Code's Slidev extension: a served page is a drivable
 * Slidev server iff it answers HTTP 200 AND carries the `slidev:version` meta
 * tag. A 200 without that tag is a foreign or too-old server we refuse rather
 * than open a broken window onto.
 *
 * Spawn, free-port selection, HTTP probing, the clock, and the sleeper are all
 * injected so the readiness logic runs deterministically under Vitest with no
 * real Slidev, no real socket, and no wall-clock waiting. `main/index.ts` wires
 * the real adapters below.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import { augmentAgentSpawnPath } from '@inkeep/open-knowledge-core';
import { projectLocalSlidevBin } from './slidev-resolve.ts';

/** The subprocess surface the readiness poll drives. Named methods (not a
 *  structural `ChildProcess`) keep the fake in tests tiny and sidestep the
 *  EventEmitter overload friction, matching `ProbeChild` in claude-readiness. */
export interface SlidevProcess {
  onExit(cb: (code: number | null) => void): void;
  /** Deliver `signal` to the process — for the real adapter, to its whole
   *  process group so the forked Vite dev server dies with the launcher.
   *  Best-effort: a signal to an already-exited process is a no-op. */
  signal(signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Whether the process is still running — drives the graceful-teardown grace
   *  poll (SIGTERM, wait, escalate). */
  isAlive(): boolean;
  readonly pid: number | undefined;
  /** The `'error'` event's error, when the launch itself failed (ENOENT when
   *  `slidev` is not on PATH, EACCES when it is not executable). Undefined for a
   *  process that started and later exited — that is a different failure, and
   *  conflating the two reports "couldn't render" for "couldn't launch". */
  readonly spawnError?: NodeJS.ErrnoException | undefined;
}

/** One HTTP readiness observation. `reachable: false` folds every
 *  not-yet-serving state (connection refused during boot, non-200, fetch
 *  error) into a single retry signal; a reachable page reports whether it is a
 *  Slidev deck via the version meta tag. */
export type ReadinessProbe = { reachable: false } | { reachable: true; hasVersionMeta: boolean };

/** Why a start did not yield a live, drivable Slidev server. `spawn-error` and
 *  `exited-early` mean no process is left running; `timeout` and
 *  `unsupported-server` mean the poll reaped the process before returning.
 *  Not exported — the wire maps these into `SlidevOpenFailureReason`; nothing
 *  outside this module needs the name. */
type SlidevStartFailure = 'spawn-error' | 'exited-early' | 'timeout' | 'unsupported-server';

export type StartSlidevResult =
  | { ok: true; port: number; process: SlidevProcess }
  | { ok: false; reason: SlidevStartFailure };

export interface StartSlidevDeps {
  /** Pick an unused TCP port to serve on. */
  findFreePort(): Promise<number>;
  /** Launch `slidev` against the deck, serving on `port`. */
  spawnSlidev(port: number): SlidevProcess;
  /** GET the served root and classify readiness. Contract: total — reports
   *  `reachable: false` for connection/HTTP failures rather than rejecting. */
  probeReady(port: number): Promise<ReadinessProbe>;
  /** Monotonic-enough clock for the deadline (real: `Date.now`). */
  now(): number;
  /** Sleep between polls (real: `setTimeout`). */
  delay(ms: number): Promise<void>;
  /**
   * Called with the child the instant it is spawned, before readiness is
   * probed. A deck only reaches the registry once its server is CONFIRMED
   * serving, and a cold Vite start takes seconds — so without this hook a quit
   * landing inside that window finds nothing to signal, and the `detached`
   * process outlives the app holding its port. This makes the handle reachable
   * from spawn rather than from success.
   */
  onSpawned?(process: SlidevProcess): void;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** Slidev cold start pays a Vite dev-server boot; give it generous headroom
 *  before declaring a hang, and poll often enough that a ready server opens
 *  promptly. */
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export async function startSlidevServer(deps: StartSlidevDeps): Promise<StartSlidevResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let port: number;
  let child: SlidevProcess;
  try {
    port = await deps.findFreePort();
    child = deps.spawnSlidev(port);
  } catch (err) {
    // Trust boundary: child_process.spawn throws synchronously on resource
    // exhaustion (EMFILE/ENOMEM), and a port bind can fail. The child never
    // started, so there is nothing to reap. Log the OS error code so EMFILE /
    // ENOMEM / EACCES stay separable in diagnostics — otherwise every cause logs
    // identically as a bare 'spawn-error'. The wire reason stays the bounded
    // literal; no path or free-form string crosses the IPC boundary.
    console.warn(
      JSON.stringify({
        event: 'slides-spawn-error',
        code: (err as NodeJS.ErrnoException | null)?.code ?? null,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return { ok: false, reason: 'spawn-error' };
  }
  // Publish the handle before the readiness poll — everything below this line
  // can take seconds, and app-quit teardown has to be able to reach the child
  // during all of it.
  deps.onSpawned?.(child);

  let exited = false;
  child.onExit(() => {
    exited = true;
  });

  const deadline = deps.now() + timeoutMs;
  while (true) {
    if (exited) {
      // A launch that never started (ENOENT / EACCES) also lands here via the
      // 'error' event, but it is a different failure from a deck that crashed
      // after serving — report it as such so the user is told Slidev could not
      // be found rather than that their document could not be rendered.
      if (child.spawnError !== undefined) return { ok: false, reason: 'spawn-error' };
      // Slidev quit before it served (unreadable deck, a port it could not
      // bind, a crash). Already dead — no reap needed.
      return { ok: false, reason: 'exited-early' };
    }
    const probe = await deps.probeReady(port);
    // The process can exit DURING the probe await, so re-check before acting on
    // a probe result from an already-dead server (not a duplicate of the pre-
    // probe check above).
    if (exited) {
      if (child.spawnError !== undefined) return { ok: false, reason: 'spawn-error' };
      return { ok: false, reason: 'exited-early' };
    }
    if (probe.reachable) {
      if (probe.hasVersionMeta) return { ok: true, port, process: child };
      // Answers HTTP but is not a Slidev deck we can drive (foreign server, or
      // one too old to carry the meta tag). A failed start is hard-reaped, not
      // gracefully drained: it never served, so nothing needs to flush, and a
      // guaranteed kill keeps the no-orphan promise on the error path. (The
      // window-close teardown, where a deck WAS serving, is the graceful one.)
      child.signal('SIGKILL');
      return { ok: false, reason: 'unsupported-server' };
    }
    if (deps.now() >= deadline) {
      // Hung past the readiness deadline — hard-reap for the same reason.
      child.signal('SIGKILL');
      return { ok: false, reason: 'timeout' };
    }
    await deps.delay(pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Real adapters — the OS-facing implementations `main/index.ts` injects. The
// pure state machine above is exercised in tests with fakes; these carry the
// I/O the tests do not.
// ---------------------------------------------------------------------------

/**
 * Ask the OS for an unused loopback TCP port by binding to 0 and reading the
 * assigned port back. Binds on `localhost` (not a pinned `127.0.0.1`) so the
 * free-port check runs on the SAME address family Slidev/Vite then binds — both
 * resolve `localhost` verbatim, which puts `::1` first on macOS. Pinning IPv4
 * here would verify a different family than Slidev uses, so a port free on IPv4
 * but taken on IPv6 would pass this check and then fail Slidev's bind. A port
 * freed this way can still race another binder before Slidev claims it, but
 * Slidev picking a busy port surfaces as `exited-early` or a readiness
 * `timeout` — the same reaped-and-reported paths as any other bad start, so no
 * orphan results.
 */
export function findFreePort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close();
        rejectPort(new Error('could not resolve a free port'));
        return;
      }
      const { port } = addr;
      server.close(() => resolvePort(port));
    });
  });
}

/** Slidev serves this meta tag in its index HTML; VS Code reads the same tag to
 *  detect and version-gate a running server. Matched loosely (`property=` or
 *  `name=`) so an attribute-order or attribute-name change upstream still
 *  detects a genuine Slidev page. */
const SLIDEV_VERSION_META_RE = /<meta[^>]*slidev:version/i;

/** Per-probe HTTP timeout — short, because an unreachable port should fail fast
 *  and let the outer poll retry rather than stall a whole poll interval. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * HTTP-probe a spawned Slidev at `localhost:<port>` and classify readiness.
 * Total by contract: connection refused (server not listening yet), a non-200,
 * or any fetch error collapses to `reachable: false` so the poll keeps trying
 * through boot; only a 200 is inspected for the version meta tag.
 *
 * The host must stay `localhost` rather than a pinned `127.0.0.1`: Vite — and so
 * Slidev — listens on whatever `localhost` resolves to, and Node resolves it
 * verbatim, which on macOS puts `::1` first. A real Slidev therefore binds the
 * IPv6 loopback ONLY, an IPv4-pinned probe is refused for the entire readiness
 * window, and a healthy server gets reaped as a `timeout`. `localhost` reaches
 * either family via happy-eyeballs and still resolves only to loopback, so the
 * loopback-only guarantee is unchanged. Keep in sync with the window's embed URL.
 */
export async function probeSlidevReady(port: number): Promise<ReadinessProbe> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { reachable: false };
    const html = await res.text();
    return { reachable: true, hasVersionMeta: SLIDEV_VERSION_META_RE.test(html) };
  } catch {
    // Trust boundary: the server may not be listening yet
    // (ECONNREFUSED), the socket may reset mid-boot, or the fetch may time out.
    // None of these mean "not Slidev" — only "not ready" — so retry.
    return { reachable: false };
  }
}

/** How to launch `slidev` for a deck. A project-local install is an executable
 *  path we can spawn directly, so its `projectRoot` is bound non-optional; a
 *  global one lives only on the user's login shell PATH (a GUI Electron process
 *  does not inherit it) and may run in a project-less window, so its
 *  `projectRoot` is optional. Discriminated on `source` so the illegal
 *  `project-local` + absent-root state is unrepresentable — the direct-spawn
 *  path can rely on the root at compile time. */
export type SlidevSpawnConfig = {
  /** Absolute path of the deck to serve. */
  readonly docPath: string;
  /** The user's login shell, for the global-install launch. */
  readonly shell: string;
} & (
  | { readonly source: 'project-local'; readonly projectRoot: string }
  | { readonly source: 'global'; readonly projectRoot: string | undefined }
);

/** A resolved spawn descriptor — either a direct executable launch or a
 *  login-shell command line. Pure output of {@link buildSlidevInvocation} so
 *  the argv/quoting is unit-testable without spawning. */
export type SlidevInvocation =
  | { readonly mode: 'direct'; readonly file: string; readonly args: readonly string[] }
  | { readonly mode: 'login-shell'; readonly file: string; readonly args: readonly string[] }
  /** Windows: `cmd.exe /c <target> …` — the only way to run a `.cmd` shim, and
   *  how a global install is resolved against PATHEXT. `args` is already a
   *  cmd-quoted command line, so the spawn MUST set `windowsVerbatimArguments`
   *  (see {@link realSpawnSlidev}); letting libuv re-quote it would escape the
   *  inner quotes with backslashes, which cmd does not understand. */
  | {
      readonly mode: 'windows-shell';
      readonly file: string;
      readonly args: readonly string[];
      readonly verbatim: true;
    };

/** POSIX single-quote: wrap in `'…'` and escape embedded quotes as `'\''`. The
 *  canonical injection-safe quoting for a value spliced into a shell command
 *  line (the global-install deck path). */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Wrap a token for `cmd.exe`. Double quotes make `&  |  <  >  ^` inert; the
 *  two characters quoting cannot neutralize (`"` and `%`) are refused at
 *  admission by `validateSpawnPath`, so there is nothing left to escape. */
function cmdQuote(value: string): string {
  return `"${value}"`;
}

/**
 * Build the spawn descriptor for `slidev <docPath> --port <port>`. Served at
 * the root with no `--base`, sidestepping the two open upstream `--base` /
 * `routerMode` embed regressions.
 *
 * A project-local install spawns directly (argv array, no shell) — zero
 * injection surface. A global install routes through `<shell> -l -i -c` so the
 * bare `slidev` resolves against the same login-shell PATH the detect step used
 * ("detected ⇒ launchable"); the deck path is single-quoted against injection.
 */
export function buildSlidevInvocation(
  config: SlidevSpawnConfig,
  port: number,
  platform: NodeJS.Platform = process.platform,
): SlidevInvocation {
  const portArgs = ['--port', String(port)];
  if (platform === 'win32') {
    // Windows has no POSIX login shell — `-l -i -c` are flags `cmd.exe` does
    // not understand, and the GUI-PATH problem those flags exist to solve is a
    // macOS/Linux launcher issue (a Windows GUI process inherits the user PATH
    // from the registry). Both sources therefore route through `cmd.exe /c`:
    // the project-local shim is a `.cmd`, which `CreateProcess` cannot run
    // directly, and a global install is resolved by cmd against PATHEXT.
    //
    // An argv array is NOT a safety boundary here. Node joins argv into a single
    // command line quoting only values containing a space, tab, or quote (the
    // `CommandLineToArgvW` convention libuv follows), and `cmd.exe` then
    // re-parses that line under its own grammar, where `&` separates commands.
    // A deck named `a&calc.exe&b.md` contains no space, so it would arrive
    // unquoted and the second command would run. The two conventions do not
    // compose, so the command line is built here and handed over verbatim.
    const target =
      config.source === 'project-local'
        ? projectLocalSlidevBin(config.projectRoot, platform)
        : 'slidev';
    // `/s` strips exactly the outer quote pair and treats the remainder
    // literally, so each token can carry its own quotes. `"` and `%` are refused
    // upstream by `validateSpawnPath` because quoting cannot neutralize them.
    const cmdline = `"${cmdQuote(target)} ${cmdQuote(config.docPath)} ${portArgs.join(' ')}"`;
    return {
      mode: 'windows-shell',
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', cmdline],
      verbatim: true,
    };
  }
  if (config.source === 'project-local') {
    // The discriminated config guarantees a project root for a project-local
    // source, so the direct-spawn path can use it without a runtime guard.
    const bin = projectLocalSlidevBin(config.projectRoot, platform);
    return { mode: 'direct', file: bin, args: [config.docPath, ...portArgs] };
  }
  const cmdline = `exec slidev ${shSingleQuote(config.docPath)} ${portArgs.join(' ')}`;
  return { mode: 'login-shell', file: config.shell, args: ['-l', '-i', '-c', cmdline] };
}

/** Best-effort delivery of `sig` to `child` and, on POSIX, its process group —
 *  Slidev forks a Vite dev server, so signalling only the direct child would
 *  orphan it. On Windows there is no process group and SIGTERM carries no
 *  graceful meaning, so a reap is always a direct terminate regardless of the
 *  signal asked for. */
function signalSlidevChild(child: ChildProcess, sig: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    // No such group (already exited) — fall back to the direct child.
    try {
      child.kill(sig);
    } catch {
      // Already gone.
    }
  }
}

/** True iff `dir` exists and is a directory — the existence gate
 *  `augmentAgentSpawnPath` uses to append only real tool dirs. */
function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `process.env` with PATH repaired: a Dock/Finder-launched app inherits
 * launchd's minimal PATH, under which a project-local `.bin/slidev` shebang
 * (`#!/usr/bin/env node`) cannot find `node`. Appends the well-known tool +
 * package-manager global dirs, the same augmentation git and ACP spawns use.
 */
function repairedSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PATH = augmentAgentSpawnPath(env.PATH, {
    platform: process.platform,
    homeDir: homedir(),
    isDir,
    delimiter,
  });
  return env;
}

/**
 * Spawn a real Slidev process and adapt it to {@link SlidevProcess}. POSIX
 * spawns `detached` for process-group leadership so {@link signalSlidevChild}
 * can reap the whole tree. `onExit` also fires on the async `'error'` event (an
 * ENOENT/EACCES that never produces an `'exit'`), so a failed launch settles
 * the readiness poll immediately instead of stalling to its timeout.
 */
export function realSpawnSlidev(config: SlidevSpawnConfig, port: number): SlidevProcess {
  const invocation = buildSlidevInvocation(config, port);
  const child = spawn(invocation.file, [...invocation.args], {
    cwd: config.projectRoot,
    env: repairedSpawnEnv(),
    stdio: 'ignore',
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    // The windows-shell arm hands over an already-quoted cmd command line;
    // letting libuv re-quote it would backslash-escape the inner quotes, which
    // cmd does not understand.
    windowsVerbatimArguments: invocation.mode === 'windows-shell',
  });
  // Track liveness off the process's own exit/error rather than a pid probe: for
  // a child we own, a probe would race the OS reaping the exited pid, while the
  // exit event is authoritative.
  let alive = true;
  // Keep the spawn error rather than only its liveness effect: an ENOENT (no
  // `slidev` on PATH) and an EACCES (present but not executable) are the two
  // most common "why doesn't this work?" causes, and both otherwise reach the
  // readiness poll as an indistinguishable `alive === false` and get reported as
  // `exited-early` — "Slidev couldn't render this document" for what is really
  // "Slidev could not be launched".
  let spawnError: NodeJS.ErrnoException | undefined;
  child.on('exit', () => {
    alive = false;
  });
  child.on('error', (err: NodeJS.ErrnoException) => {
    alive = false;
    spawnError = err;
    console.warn(
      JSON.stringify({
        event: 'slides-child-error',
        code: err?.code ?? null,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  });
  return {
    onExit: (cb) => {
      child.on('exit', (code) => cb(code));
      child.on('error', () => cb(null));
    },
    get spawnError() {
      return spawnError;
    },
    signal: (sig) => signalSlidevChild(child, sig),
    isAlive: () => alive,
    get pid() {
      return child.pid;
    },
  };
}
