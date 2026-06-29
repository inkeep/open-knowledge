
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

const BUNDLE_IDENTITY_ANCHOR = fileURLToPath(import.meta.url);

const execFileAsync = promisify(execFile);

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
  startupCwd: string;
  startupConfig: Config;
  spawnTimeoutMs?: number;
  envAutoStart?: string;
}

interface StartGlobalMcpServerHandle {
  close: () => Promise<void>;
}

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

export function rootUriToFsPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return undefined;
    return fileURLToPath(parsed);
  } catch {
    return undefined;
  }
}

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
    opts.log?.(`single root URI not usable as fs path: ${roots[0].uri}`);
  }
  return fsPath;
}

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
    const pd = findProject(sticky);
    return { projectDir: pd, viaRootGuess: false, nextSticky: pd };
  }
  const fromRoots = await rootsFallback();
  if (fromRoots === undefined) {
    return { projectDir: undefined, viaRootGuess: false, nextSticky: undefined };
  }
  return { projectDir: findProject(fromRoots), viaRootGuess: true, nextSticky: undefined };
}

const CWD_REQUIRED_MESSAGE =
  '`cwd` is required for tool calls against the global MCP server. Pass an absolute path inside an OpenKnowledge project, or have the MCP client advertise a single root.';

export async function startGlobalMcpServer(
  opts: StartGlobalMcpServerOptions,
): Promise<StartGlobalMcpServerHandle> {
  const stderr = process.stderr;
  const spawnTimeoutMs =
    opts.spawnTimeoutMs ?? parseSpawnTimeoutEnv(process.env.OK_MCP_SPAWN_TIMEOUT_MS);
  const envAutoStart = opts.envAutoStart ?? process.env.OK_MCP_AUTOSTART;

  const resolveConfigForCwd = createProjectConfigResolver({
    startupCwd: opts.startupCwd,
    startupConfig: opts.startupConfig,
  });

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

  const keepalivesByProject = new Map<string, KeepaliveHandle>();

  const ensureKeepaliveForProject = (projectDir: string): void => {
    if (keepalivesByProject.has(projectDir)) return;
    const lockDir = getLocalDir(projectDir);
    const id = identityRef.current;
    const handle = startKeepalive({
      connectionId,
      pid: process.pid,
      displayName: id.displayName,
      clientName: id.clientInfo?.name ?? id.displayName,
      colorSeed: id.colorSeed,
      resolveWsUrl: async () => resolveMcpKeepaliveWsUrl({ lockDir, contentDir: projectDir }, ''),
      log: (msg) => stderr.write(`[mcp] keepalive[${projectDir}]: ${msg}\n`),
    });
    keepalivesByProject.set(projectDir, handle);
  };

  const rootsFallback = (): Promise<string | undefined> =>
    tryListRootsFallback({
      getClientCapabilities: () => server.server.getClientCapabilities(),
      listRoots: () => server.server.listRoots() as Promise<{ roots: { uri: string }[] }>,
      log: (msg) => stderr.write(`[mcp] ${msg}\n`),
    });

  let stickyProjectDir: string | undefined;
  let warnedWorktreeAmbiguity = false;

  const maybeWarnWorktreeAmbiguity = async (projectDir: string): Promise<void> => {
    if (warnedWorktreeAmbiguity) return;
    warnedWorktreeAmbiguity = true;
    const count = await countWorktrees(projectDir);
    if (count <= 1) {
      warnedWorktreeAmbiguity = false;
      return;
    }
    const msg =
      `Routed to ${projectDir} from the MCP client's single advertised root, but this repo ` +
      `has ${count} git worktrees. If you are working in a worktree, pass its path as \`cwd\` on ` +
      `OK tool calls once — it sticks for the session, so reads, writes, and the preview all ` +
      `target that worktree instead of this checkout.`;
    try {
      stderr.write(`[mcp] ${msg}\n`);
      await server.server.sendLoggingMessage({ level: 'warning', data: msg });
    } catch {
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
    ensureKeepaliveForProject(projectDir);
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

  attachLifecycleLogging({
    log: (m) => stderr.write(`${m}\n`),
    transport,
    process,
    stdin: process.stdin,
  });

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
