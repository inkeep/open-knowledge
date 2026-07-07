/**
 * Inline stdio MCP server for `open-knowledge mcp`.
 *
 * One stdio process can serve many OpenKnowledge projects: each tool call
 * resolves its own cwd by walking up to the nearest `.ok/config.yml`, loads
 * the matching config, and routes HTTP traffic to the running `ok start` for
 * that project (auto-spawning if `OK_MCP_AUTOSTART` is unset or non-zero).
 *
 * This makes it safe to register `ok mcp` once globally in an MCP host such
 * as Claude: the host can call tools against any local OK project by
 * passing an absolute `cwd` argument, and the server fans the call out to
 * the right per-project HTTP backend.
 *
 * Per-project keepalive WebSockets keep the routed-to backends alive: the
 * first time we resolve a URL for a given `projectDir`, we open a bare
 * `/collab/keepalive` WS to that backend (see `keepalive.ts` for why). All
 * keepalives reuse the same `connectionId` derived from the MCP client's
 * `clientInfo` — agents that fan out across multiple projects on the host
 * appear as a single coherent identity rather than per-project ghosts.
 *
 * Implicit-cwd fallback: when an MCP client omits the `cwd` argument and the
 * client advertised the `roots` capability with exactly one root, we treat
 * that root as the cwd. This honors the contract `ROUTED_CWD_DESCRIPTION`
 * documents — single-root clients (the typical IDE shape) keep working
 * without forcing every tool description to require explicit `cwd`.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { OK_PROJECT_MARKER } from '@inkeep/open-knowledge-core';
import { type KeepaliveHandle, startKeepalive } from '@inkeep/open-knowledge-core/keepalive';
import {
  type AgentIdentity,
  type Config,
  getLocalDir,
  installPrettyZodErrors,
  isProjectRoot,
  MCP_SERVER_NAME,
  RUNTIME_VERSION,
  registerAllTools,
  resolveContentDir,
  sanitizeClientName,
} from '@inkeep/open-knowledge-server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProjectConfigResolver } from '../config/loader.ts';
import {
  type BundleIdentityWatcherHandle,
  captureBootIdentity,
  detectBundleIdentity,
  startBundleIdentityWatcher,
} from './bundle-identity.ts';
import { type HostLivenessWatchHandle, startHostLivenessWatch } from './host-liveness.ts';
import { attachLifecycleLogging } from './lifecycle-logging.ts';
import { parseSpawnTimeoutEnv, resolveMcpHttpUrl, resolveMcpKeepaliveWsUrl } from './shim.ts';

/**
 * Stable in-bundle anchor used by the periodic bundle-identity self-check.
 * `import.meta.url` is captured at module load — before any drag-replace
 * can rotate inodes — and points at a file inside the same `Contents/`
 * tree as the running Mach-O image. Uses `import.meta.url` rather than
 * `process.execPath` because Node binaries set execPath to the host
 * process (e.g. `/usr/local/bin/bun`), not the OK bundle.
 */
const BUNDLE_IDENTITY_ANCHOR = fileURLToPath(import.meta.url);

const execFileAsync = promisify(execFile);

/**
 * Count the git worktrees the repo enclosing `dir` exposes (`git worktree list`
 * always reports the main checkout plus every linked worktree). Used only by
 * the worktree-ambiguity nudge: a `cwd`-less call that resolved into a project
 * with more than one worktree MIGHT be misrouted (the agent could be acting in
 * a sibling/nested worktree the MCP client didn't advertise). Returns 0 when
 * `dir` isn't a git repo or git is unavailable — callers treat that as "no
 * ambiguity". Bounded timeout so a slow/hung git never stalls resolution.
 */
export async function countWorktrees(dir: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], {
      timeout: 2000,
    });
    return stdout.split('\n').filter((line) => line.startsWith('worktree ')).length;
  } catch {
    return 0;
  }
}

interface StartGlobalMcpServerOptions {
  /** Working directory at startup; only used to seed the per-cwd config cache. */
  startupCwd: string;
  /** Resolved config at startup; only used to seed the per-cwd config cache. */
  startupConfig: Config;
  /** Deadline for `ok start` auto-spawn during a tool call. */
  spawnTimeoutMs?: number;
  /** Override `OK_MCP_AUTOSTART` lookup; primarily for tests. */
  envAutoStart?: string;
}

interface StartGlobalMcpServerHandle {
  close: () => Promise<void>;
}

/**
 * Walk up from `startCwd` looking for the nearest ancestor directory that
 * is a valid OK project root (`.ok/config.yml` exists as a regular file).
 * Throws when none is found. Project-root check delegates to the shared
 * `isProjectRoot` helper — see `find-project-root.ts` for the rationale on
 * why the marker is the config file, not the `.ok/` directory.
 */
export function findProjectDir(startCwd: string): string {
  let dir = resolve(startCwd);
  while (true) {
    if (isProjectRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `No OpenKnowledge project found at or above ${startCwd}. Pass an explicit \`cwd\` argument that points inside an OK project (a directory with a \`${OK_PROJECT_MARKER}\`).`,
      );
    }
    dir = parent;
  }
}

/**
 * Decode an MCP root URI (`file:///abs/path` per spec) into a filesystem path.
 * Returns undefined for non-`file:` schemes or malformed URIs — callers fall
 * back to the explicit-cwd-required error.
 */
export function rootUriToFsPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return undefined;
    return fileURLToPath(parsed);
  } catch {
    return undefined;
  }
}

/**
 * MCP-roots single-root fallback: returns the filesystem path of the client's
 * sole `file://` root, or `undefined` when the client has no roots capability,
 * advertised zero or multiple roots, the root URI uses a non-`file:` scheme,
 * or `listRoots()` itself failed (transport error, protocol error, SDK bug).
 *
 * The SDK call is a JSON-RPC round-trip to a different process — log failures
 * via the injected `log` so operators have a breadcrumb for the otherwise
 * generic "cwd is required" error tool calls would surface.
 */
export async function tryListRootsFallback(opts: {
  getClientCapabilities: () => { roots?: unknown } | undefined;
  listRoots: () => Promise<{ roots: { uri: string }[] }>;
  log?: (msg: string) => void;
}): Promise<string | undefined> {
  const caps = opts.getClientCapabilities();
  if (!caps?.roots) return undefined;
  let result: { roots: { uri: string }[] };
  try {
    result = await opts.listRoots();
  } catch (err) {
    opts.log?.(`listRoots fallback failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  const roots = result.roots ?? [];
  if (roots.length !== 1) return undefined;
  const fsPath = rootUriToFsPath(roots[0].uri);
  if (fsPath === undefined) {
    // Symmetric breadcrumb to the listRoots-throws branch above: a single
    // root that can't be turned into a fs path (non-`file:` scheme,
    // malformed URI) would otherwise surface only as the generic
    // "cwd is required" tool error.
    opts.log?.(`single root URI not usable as fs path: ${roots[0].uri}`);
  }
  return fsPath;
}

/** Outcome of one sticky project resolution. */
export interface StickyProjectResolution {
  /** Resolved OK project root, or `undefined` when nothing resolves. The
   *  caller decides whether `undefined` throws (`resolveCwd`) or yields no
   *  server URL (`resolveServerUrlForCwd`). */
  projectDir: string | undefined;
  /** True only when resolution fell through to the MCP client's single-root
   *  guess — the one rung where a silent wrong-project is possible, so the
   *  only rung the worktree-ambiguity nudge fires on. */
  viaRootGuess: boolean;
  /** Project root to remember as the new sticky anchor: set by an explicit
   *  `cwd` (and unchanged on sticky reuse); a root guess never sticks. */
  nextSticky: string | undefined;
}

/**
 * Resolve the project dir for a tool call with worktree-aware sticky
 * precedence: an explicit `cwd` wins (and becomes the new sticky anchor);
 * otherwise the remembered sticky project; otherwise the MCP client's
 * single-root guess. Pure — the only I/O is the injected `rootsFallback` (and
 * `findProject`, which still throws for a non-OK path on either the explicit
 * or the guessed branch, preserving the original directive error). The sticky
 * layer is what lets an agent in a worktree name it once (`cwd`) and have
 * later `cwd`-less calls stay on that worktree instead of re-guessing main.

 */
export async function resolveStickyProjectDir(
  explicit: string | undefined,
  sticky: string | undefined,
  rootsFallback: () => Promise<string | undefined>,
  findProject: (startCwd: string) => string = findProjectDir,
): Promise<StickyProjectResolution> {
  if (explicit !== undefined) {
    const pd = findProject(explicit);
    return { projectDir: pd, viaRootGuess: false, nextSticky: pd };
  }
  if (sticky !== undefined) {
    // Re-validate the remembered anchor on every reuse: a worktree deleted
    // mid-session would otherwise resolve to a stale path silently. findProject
    // walks up from the (now possibly gone) sticky dir, so it either re-anchors
    // to a surviving enclosing project or throws the same directive error as the
    // explicit/guess branches — surfacing the change instead of operating on a
    // dead path.
    const pd = findProject(sticky);
    return { projectDir: pd, viaRootGuess: false, nextSticky: pd };
  }
  const fromRoots = await rootsFallback();
  if (fromRoots === undefined) {
    return { projectDir: undefined, viaRootGuess: false, nextSticky: undefined };
  }
  return { projectDir: findProject(fromRoots), viaRootGuess: true, nextSticky: undefined };
}

/** Directive thrown by `resolveCwd` when no project can be resolved for a call. */
const CWD_REQUIRED_MESSAGE =
  '`cwd` is required for tool calls against the global MCP server. Pass an absolute path inside an OpenKnowledge project, or have the MCP client advertise a single root.';

/**
 * Boot an inline stdio MCP server that routes per-call to whatever OK project
 * the caller's `cwd` resolves into.
 */
export async function startGlobalMcpServer(
  opts: StartGlobalMcpServerOptions,
): Promise<StartGlobalMcpServerHandle> {
  const stderr = process.stderr;
  const spawnTimeoutMs =
    opts.spawnTimeoutMs ?? parseSpawnTimeoutEnv(process.env.OK_MCP_SPAWN_TIMEOUT_MS);
  const envAutoStart = opts.envAutoStart ?? process.env.OK_MCP_AUTOSTART;

  // TTL-cached so repeated tool calls against the same project don't re-parse
  // YAML for every invocation.
  const resolveConfigForCwd = createProjectConfigResolver({
    startupCwd: opts.startupCwd,
    startupConfig: opts.startupConfig,
  });

  // No `instructions` handshake: agent steering for OK projects is delivered
  // by the relevance-gated project skill, not an always-on MCP echo. Emitting
  // it globally steered agents in non-OK projects toward OK tools they can't
  // use.
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: RUNTIME_VERSION,
  });
  installPrettyZodErrors(server);

  const connectionId = randomUUID();
  const identityRef: { current: AgentIdentity } = {
    current: {
      connectionId,
      displayName: connectionId,
      colorSeed: connectionId,
    },
  };

  // Per-project keepalive WS map. Lazily populated on the first
  // `resolveServerUrlForCwd` hit per project. All keepalives share `connectionId`
  // — the global stdio process is one logical agent regardless of how many
  // projects it touches, and presence on each backend keys off this same id.
  const keepalivesByProject = new Map<string, KeepaliveHandle>();

  const ensureKeepaliveForProject = (projectDir: string): void => {
    if (keepalivesByProject.has(projectDir)) return;
    const lockDir = getLocalDir(projectDir);
    // startKeepalive returns synchronously (defers connect via queueMicrotask),
    // so no re-entry can occur between the has() guard above and the set()
    // below.
    //
    // Snapshot identity at keepalive-creation time. `oninitialized` runs
    // before any tool call — and tools are the only callers of
    // `ensureKeepaliveForProject` — so by the time we get here, identityRef
    // reflects the negotiated client identity (clientInfo.name from the MCP
    // initialize). Passing the snapshot lets the server bootstrap a presence
    // entry on WS upgrade, before the agent's first tool roundtrip.
    const id = identityRef.current;
    const handle = startKeepalive({
      connectionId,
      pid: process.pid,
      displayName: id.displayName,
      clientName: id.clientInfo?.name ?? id.displayName,
      colorSeed: id.colorSeed,
      // Re-read `server.lock` on every connect attempt: a backend that
      // respawned on a different port (auto-spawn after idle-shutdown) is
      // picked up transparently. resolveMcpKeepaliveWsUrl ignores the
      // endpointUrl argument when portOverride is unset, so we pass `''`.
      resolveWsUrl: async () => resolveMcpKeepaliveWsUrl({ lockDir, contentDir: projectDir }, ''),
      log: (msg) => stderr.write(`[mcp] keepalive[${projectDir}]: ${msg}\n`),
    });
    keepalivesByProject.set(projectDir, handle);
  };

  // Bind the SDK-facing dependencies of the roots fallback once: each call
  // re-queries `getClientCapabilities()` and `listRoots()`, so per-tool-call
  // resolution remains current without subscribing to `roots/list_changed`.
  // Diagnostics route through `stderr` so an operator sees a breadcrumb when
  // the JSON-RPC roots query fails (transport, protocol, SDK mismatch).
  const rootsFallback = (): Promise<string | undefined> =>
    tryListRootsFallback({
      getClientCapabilities: () => server.server.getClientCapabilities(),
      listRoots: () => server.server.listRoots() as Promise<{ roots: { uri: string }[] }>,
      log: (msg) => stderr.write(`[mcp] ${msg}\n`),
    });

  // --- Worktree-aware sticky routing ---
  //
  // The connection remembers the last EXPLICIT `cwd` it was handed; later calls
  // that omit `cwd` reuse it instead of re-guessing from the client's single
  // advertised root. Precedence per call: explicit > sticky > single-root > error.
  // This is per-connection state — `startGlobalMcpServer` runs once per `ok mcp`
  // stdio process, and each editor window spawns its own process — so concurrent
  // worktree sessions in separate windows never share an anchor.
  let stickyProjectDir: string | undefined;
  // The ambiguity nudge fires at most once per connection.
  let warnedWorktreeAmbiguity = false;

  // Fire-and-forget nudge: when a `cwd`-less call resolved into a project via the
  // client's single-root guess (the one rung where a silent wrong-project is
  // possible), and that project has multiple git worktrees, warn ONCE. We cannot
  // distinguish "legitimately in main" from "in a worktree the client didn't
  // advertise" from the root alone, so we warn rather than refuse — a hard error
  // would break the common "working in main while feature worktrees exist" case.
  const maybeWarnWorktreeAmbiguity = async (projectDir: string): Promise<void> => {
    if (warnedWorktreeAmbiguity) return;
    // Claim the slot synchronously, before the `await` below, so two concurrent
    // root-guess calls can't both pass the guard and double-fire the nudge
    // (the check + claim share one event-loop tick — no interleave possible).
    warnedWorktreeAmbiguity = true;
    const count = await countWorktrees(projectDir);
    if (count <= 1) {
      // Nothing to warn about (0 = not a repo / git absent; 1 = only this
      // checkout). Release the slot: worktree count is NOT stable within a
      // session — the agent may create a worktree mid-flight — so a later
      // cwd-less root-guess call must still be able to nudge.
      warnedWorktreeAmbiguity = false;
      return;
    }
    const msg =
      `Routed to ${projectDir} from the MCP client's single advertised root, but this repo ` +
      `has ${count} git worktrees. If you are working in a worktree, pass its path as \`cwd\` on ` +
      `OK tool calls once — it sticks for the session, so reads, writes, and the preview all ` +
      `target that worktree instead of this checkout.`;
    // Both emits are best-effort and this runs from a `void`-ed (fire-and-forget)
    // call, so any throw would surface as an unhandled rejection: `stderr` can
    // EPIPE on a closed pipe, and the client may not support logging
    // notifications. Swallow both — the nudge is advisory.
    try {
      stderr.write(`[mcp] ${msg}\n`);
      await server.server.sendLoggingMessage({ level: 'warning', data: msg });
    } catch {
      // Nothing actionable if neither channel is available.
    }
  };

  const resolveCwd = async (explicit?: string): Promise<string> => {
    const r = await resolveStickyProjectDir(explicit, stickyProjectDir, rootsFallback);
    stickyProjectDir = r.nextSticky ?? stickyProjectDir;
    if (r.projectDir === undefined) throw new Error(CWD_REQUIRED_MESSAGE);
    if (r.viaRootGuess) void maybeWarnWorktreeAmbiguity(r.projectDir);
    return r.projectDir;
  };

  const resolveServerUrlForCwd = async (cwd?: string): Promise<string | undefined> => {
    const r = await resolveStickyProjectDir(cwd, stickyProjectDir, rootsFallback);
    stickyProjectDir = r.nextSticky ?? stickyProjectDir;
    if (r.projectDir === undefined) return undefined;
    if (r.viaRootGuess) void maybeWarnWorktreeAmbiguity(r.projectDir);
    const projectDir = r.projectDir;
    const config = await resolveConfigForCwd(projectDir);
    const mcpUrl = await resolveMcpHttpUrl({
      lockDir: getLocalDir(projectDir),
      contentDir: resolveContentDir(config, projectDir),
      envAutoStart,
      ...(spawnTimeoutMs !== undefined ? { timeoutMs: spawnTimeoutMs } : {}),
    });
    // Open keepalive AFTER auto-spawn has yielded a live URL — opening it
    // before would race the spawn and waste reconnect attempts.
    ensureKeepaliveForProject(projectDir);
    // Tools build their own paths against this URL via `httpGet`/`httpPost`
    // (e.g. `${url}/api/backlinks`), so strip the MCP-transport suffix to
    // expose the bare HTTP origin.
    return mcpUrl.replace(/\/mcp$/, '');
  };

  server.server.oninitialized = () => {
    const clientInfo = server.server.getClientVersion();
    const name = sanitizeClientName(clientInfo?.name, connectionId);
    identityRef.current = {
      connectionId,
      clientInfo: clientInfo ? { name, version: clientInfo.version } : undefined,
      displayName: name,
      colorSeed: name,
    };
  };

  registerAllTools(server, {
    serverUrl: resolveServerUrlForCwd,
    resolveCwd,
    config: resolveConfigForCwd,
    identityRef,
    // This `ok mcp` process inherits `OK_DESKTOP_TERMINAL=1` from OK Desktop's
    // built-in terminal pty when the agent runs there (and only there — nothing
    // else sets it). `preview_url` uses it to steer the agent to `ok open`
    // instead of returning a URL it shouldn't navigate.
    isDesktopTerminal: process.env.OK_DESKTOP_TERMINAL === '1',
  });

  const transport = new StdioServerTransport();
  let closed = false;
  let bundleWatcher: BundleIdentityWatcherHandle | undefined;
  let hostLiveness: HostLivenessWatchHandle | undefined;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    bundleWatcher?.stop();
    hostLiveness?.stop();
    for (const handle of keepalivesByProject.values()) {
      try {
        handle.close();
      } catch (err) {
        stderr.write(
          `[mcp] keepalive close error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    keepalivesByProject.clear();
    const results = await Promise.allSettled([server.close(), transport.close()]);
    for (const result of results) {
      if (result.status === 'rejected') {
        const err = result.reason;
        stderr.write(
          `[mcp] shutdown close error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  };

  await server.connect(transport);
  stderr.write('[mcp] global stdio server ready (per-call project routing)\n');

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => {
      stderr.write('[mcp] shutdown deadline (5s) reached — forcing exit(1)\n');
      process.exit(1);
    }, 5000).unref();
    void close().finally(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Active host-liveness exit. The per-project keepalive WS keeps the event
  // loop alive, which disables the passive "stdin EOF -> loop drains -> exit"
  // path. Without an active signal, an `ok mcp` whose host dies orphans
  // (reparented to launchd, ppid 1) and keeps its keepalive WS open, leaving a
  // ghost agent-presence entry that never clears (the server's keepalive-close
  // cleanup never fires). Exit on any signal that the host is gone:
  //   1. stdin closes (clean host disconnect), even after a keepalive is open;
  //   2. stdin errors (socket-backed stdio whose remote end faults can emit
  //      'error' before/instead of 'end' — see lifecycle-logging.ts);
  //   3. we are reparented away from our launching host (ppid changes).
  // shutdown() is idempotent (shuttingDown guard), so overlapping triggers are
  // safe. The downstream "WS close -> grace -> clearPresence" cleanup runs as-is.
  process.stdin.on('end', () => {
    stderr.write('[mcp] stdin end — host disconnected, shutting down\n');
    shutdown();
  });
  process.stdin.on('error', (err) => {
    stderr.write(
      `[mcp] stdin error (${err instanceof Error ? err.message : String(err)}) — host disconnected, shutting down\n`,
    );
    shutdown();
  });
  hostLiveness = startHostLivenessWatch({
    getPpid: () => process.ppid,
    onHostGone: (reason) => {
      stderr.write(`[mcp] ${reason} — shutting down\n`);
      shutdown();
    },
  });

  // Diagnostic breadcrumbs so a future quiet exit can be classified from the
  // host's stderr log (peer-closed via stdin EOF vs internal shutdown via
  // transport.onclose vs uncaught). See `lifecycle-logging.ts`.
  attachLifecycleLogging({
    log: (m) => stderr.write(`${m}\n`),
    transport,
    process,
    stdin: process.stdin,
  });

  // Capture the boot-time inode of an in-bundle anchor and arm a periodic
  // check that exits the process if the on-disk inode rotates (Finder
  // drag-replace mid-session). The boot capture is fail-open — the server
  // keeps serving when the anchor is unreadable rather than crashing on a
  // transient fs hiccup. The check itself runs on a 5-minute cadence so it
  // catches a replacement that happens hours into a session, not just one
  // that happens to coincide with module load. macOS-only: drag-replace is
  // a macOS UX vector (Windows uses installer-with-restart); skipping the
  // probe + timer on other platforms removes a no-op log line that would
  // otherwise confuse operators on Linux/CI runners.
  if (process.platform === 'darwin') {
    const bootIdentity = captureBootIdentity(BUNDLE_IDENTITY_ANCHOR, {
      realpathSync,
      statInoSync: (p) => statSync(p).ino,
      log: (m) => stderr.write(`${m}\n`),
    });
    if (bootIdentity !== undefined) {
      stderr.write(
        `[mcp] bundle identity anchor=${bootIdentity.resolvedPath} inode=${bootIdentity.inode} version=${RUNTIME_VERSION}\n`,
      );
      const { resolvedPath: capturedAnchorPath, inode: capturedInode } = bootIdentity;
      bundleWatcher = startBundleIdentityWatcher({
        detect: () =>
          detectBundleIdentity({
            bundleAnchorPath: BUNDLE_IDENTITY_ANCHOR,
            currentInode: capturedInode,
            platform: process.platform,
            realpath: realpathSync,
            statInode: (p) => statSync(p).ino,
          }),
        onReplaced: (state) => {
          stderr.write(
            `[mcp] bundle replaced anchor=${capturedAnchorPath} bootInode=${state.currentInode} onDiskInode=${state.onDiskInode} version=${RUNTIME_VERSION} — exiting for host respawn\n`,
          );
          shutdown();
        },
        log: (msg) => stderr.write(`[mcp] ${msg}\n`),
      });
    }
  }

  return { close };
}
