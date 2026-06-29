import type { Server as HttpServer, ServerResponse } from 'node:http';
import {
  ASSET_EXTENSIONS,
  defaultScheduler,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
  type Scheduler,
} from '@inkeep/open-knowledge-core';
import type { Config } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { emitProblem } from './ui-problem.ts';
import {
  type ProxyServerHandle,
  proxyRequest,
  proxyUpgrade,
  rejectIfNotLoopbackApi,
  rejectUpgradeIfNotLoopback,
  startProxyServer,
} from './ui-proxy.ts';

export const DEFAULT_UI_SAFETY_NET_MS = 12 * 60 * 60 * 1000;

export const DEFAULT_UI_PORT = 39847;

export const LAUNCH_JSON_PORT = 39848;

export interface UiServerHandle {
  httpServers: HttpServer[];
  port: number;
  release: () => void;
  detachSafetyNet: () => void;
  /** Reset the safety-net timer as if activity just occurred. Called on every
   *  `/api/config` hit so an actively-used UI doesn't disconnect at 12h. */
  nudgeSafetyNet: () => void;
  /** Destroy any upgrade-detached WebSocket sockets (`/collab` forwarding
   *  pairs). Called from shutdown paths before `closeHttpServers` so the
   *  servers' close-callbacks can fire promptly — `httpServer.close()` does
   *  not track upgrade-detached sockets and would otherwise wait on them
   *  forever. Idempotent. */
  drainUpgradeSockets: () => void;
}

export async function closeHttpServers(servers: HttpServer[]): Promise<void> {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((done) => {
          s.close(() => done());
        }),
    ),
  );
}

interface StartUiServerOptions {
  config: Config;
  cwd: string;
  port: number;
  fallbackToKernel?: boolean;
  host?: string;
  safetyNetMs?: number;
  scheduler?: Scheduler;
  onSafetyNet?: () => void;
  assetDir?: string;
}

export async function startUiServer(opts: StartUiServerOptions): Promise<UiServerHandle> {
  const { existsSync } = await import('node:fs');
  const { createServer: createHttpServer } = await import('node:http');
  const { resolve } = await import('node:path');
  const {
    acquireUiLock,
    clearArmedPaneTarget,
    createAssetServeMiddleware,
    createContentFilter,
    readArmedPaneTarget,
    readServerLock,
    releaseUiLock,
    updateUiLockPort,
  } = await import('@inkeep/open-knowledge-server');
  const { default: sirv } = await import('sirv');
  const { resolveContentDir, resolveLockDir } = await import('@inkeep/open-knowledge-server');

  const contentDir = resolveContentDir(opts.config, opts.cwd);
  const lockDir = resolveLockDir(opts.cwd);

  acquireUiLock(lockDir, { port: 0, worktreeRoot: opts.cwd });

  const cliDir = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
  const assetPaths = [
    resolve(cliDir, 'public'), // npm install: dist/public/ (bundled)
    resolve(cliDir, '../../app/dist'), // monorepo dev from src/
    resolve(cliDir, '../../../app/dist'), // monorepo dev from dist/
  ];
  const assetDir = opts.assetDir ?? assetPaths.find((p) => existsSync(p));
  const staticHandler = assetDir
    ? sirv(assetDir, { single: true, gzip: true, etag: true, dev: true, extensions: [] })
    : null;

  const assetServeMiddleware = existsSync(contentDir)
    ? createAssetServeMiddleware({
        contentFilter: createContentFilter({
          projectDir: opts.cwd,
          contentDir,
        }),
        contentSirv: sirv(contentDir, { dotfiles: false, dev: true, extensions: [] }),
        inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
        assetExtensions: ASSET_EXTENSIONS,
        blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
      })
    : null;

  let resolvedPort = opts.port;

  let apiConfigNudge: (() => void) | null = null;

  const requestHandler = (req: import('node:http').IncomingMessage, res: ServerResponse) => {
    const url = req.url?.split('?')[0];

    if (req.method === 'GET' && (url === '/' || url === '')) {
      const armed = readArmedPaneTarget(lockDir);
      if (armed && !/[\r\n]/.test(armed)) {
        clearArmedPaneTarget(lockDir);
        res.statusCode = 302;
        res.setHeader('Location', `/${armed}`);
        res.setHeader('Cache-Control', 'no-store');
        res.end();
        return;
      }
    }

    if (url === '/' || url === '') {
      req.url = '/index.html';
    }

    if (url?.startsWith('/api/')) {
      if (rejectIfNotLoopbackApi(req, res)) return;
    }

    if (url === '/api/config' && req.method === 'DELETE') {
      clearArmedPaneTarget(lockDir);
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 204;
      res.end();
      return;
    }

    if (url === '/api/config' && (req.method === 'GET' || req.method === 'HEAD')) {
      apiConfigNudge?.();
      const lock = readServerLock(lockDir);
      const sameOriginHost = req.headers.host ?? `localhost:${resolvedPort}`;
      const collabUrl = lock && lock.port > 0 ? `ws://${sameOriginHost}/collab` : null;
      const paneTarget = readArmedPaneTarget(lockDir);
      const body = JSON.stringify({ collabUrl, previewUrl: null, port: resolvedPort, paneTarget });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.statusCode = 200;
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
      return;
    }

    if (url?.startsWith('/api/')) {
      apiConfigNudge?.();
      const lock = readServerLock(lockDir);
      if (!lock || lock.port <= 0) {
        emitProblem(
          res,
          503,
          'urn:ok:error:collab-server-not-running',
          'Collab server not running. Start `ok start` or run `ok status`.',
          `Path: ${url}`,
        );
        return;
      }
      proxyRequest(req, res, {
        upstreamHost: 'localhost',
        upstreamPort: lock.port,
      });
      return;
    }

    if (staticHandler && url?.startsWith('/assets/')) {
      staticHandler(req, res, () => {
        if (assetServeMiddleware) {
          assetServeMiddleware(req, res, () => notFoundStatic(res));
        } else {
          notFoundStatic(res);
        }
      });
      return;
    }

    if (assetServeMiddleware) {
      assetServeMiddleware(req, res, () => {
        if (staticHandler) {
          staticHandler(req, res);
        } else {
          notFoundStatic(res);
        }
      });
      return;
    }

    if (staticHandler) {
      staticHandler(req, res);
      return;
    }

    notFoundStatic(res);
  };

  const upgradeSocketsForShutdown = new Set<import('node:stream').Duplex>();
  const handleUpgrade = (
    req: import('node:http').IncomingMessage,
    clientSocket: import('node:stream').Duplex,
    head: Buffer,
  ): void => {
    if (rejectUpgradeIfNotLoopback(req, clientSocket)) return;
    const url = req.url?.split('?')[0] ?? '';
    if (url !== '/collab' && !url.startsWith('/collab/')) {
      clientSocket.destroy();
      return;
    }
    const lock = readServerLock(lockDir);
    if (!lock || lock.port <= 0) {
      console.warn(
        JSON.stringify({
          event: 'ok-ui-upgrade-no-collab-lock',
          url,
          reason: 'server.lock missing or port unbound — is `ok start` running?',
        }),
      );
      clientSocket.destroy();
      return;
    }
    proxyUpgrade(req, clientSocket, head, 'localhost', lock.port, upgradeSocketsForShutdown);
  };
  const drainUpgradeSockets = (): void => {
    for (const sock of upgradeSocketsForShutdown) {
      try {
        sock.destroy();
      } catch {}
    }
    upgradeSocketsForShutdown.clear();
  };

  const bindTargets: string[] = opts.host === undefined ? ['::1', '127.0.0.1'] : [opts.host];
  const httpServers: HttpServer[] = [];
  let boundPort = opts.port;

  const isEAddrInUse = (err: unknown): boolean =>
    err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';

  const tearDownPartialBinds = async (): Promise<void> => {
    await Promise.all(
      httpServers.splice(0).map(
        (s) =>
          new Promise<void>((done) => {
            try {
              s.close(() => done());
            } catch {
              done();
            }
          }),
      ),
    );
  };

  const runBindLoop = async (initialPort: number): Promise<void> => {
    boundPort = initialPort;
    for (const host of bindTargets) {
      const server = createHttpServer(requestHandler);
      server.on('upgrade', handleUpgrade);
      httpServers.push(server);
      await new Promise<void>((done, fail) => {
        const onError = (err: Error) => fail(err);
        server.once('error', onError);
        server.listen(boundPort, host, () => {
          server.off('error', onError);
          const addr = server.address();
          if (typeof addr === 'object' && addr !== null) {
            boundPort = addr.port;
          }
          done();
        });
      });
    }
  };

  try {
    try {
      await runBindLoop(opts.port);
    } catch (err) {
      if (opts.fallbackToKernel === true && isEAddrInUse(err)) {
        await tearDownPartialBinds();
        await runBindLoop(0);
      } else {
        throw err;
      }
    }
  } catch (err) {
    await tearDownPartialBinds();
    try {
      releaseUiLock(lockDir);
    } catch {}
    throw err;
  }

  const realPort = boundPort;
  resolvedPort = realPort;
  updateUiLockPort(lockDir, realPort);

  const scheduler = opts.scheduler ?? defaultScheduler;
  const safetyNetMs = opts.safetyNetMs ?? DEFAULT_UI_SAFETY_NET_MS;
  let safetyNetHandle: ReturnType<typeof scheduler.setTimeout> | null = null;
  let safetyNetCancelled = false;
  let lockReleased = false;

  const detachSafetyNet = (): void => {
    if (safetyNetCancelled) return;
    safetyNetCancelled = true;
    if (safetyNetHandle !== null) {
      scheduler.clearTimeout(safetyNetHandle);
      safetyNetHandle = null;
    }
  };

  const release = (): void => {
    detachSafetyNet();
    if (lockReleased) return;
    lockReleased = true;
    try {
      releaseUiLock(lockDir);
    } catch {}
  };

  const armSafetyNet = (): void => {
    if (safetyNetCancelled || safetyNetMs <= 0) return;
    if (safetyNetHandle !== null) {
      scheduler.clearTimeout(safetyNetHandle);
      safetyNetHandle = null;
    }
    safetyNetHandle = scheduler.setTimeout(() => {
      safetyNetHandle = null;
      console.warn(`[ui] safety-net (${safetyNetMs}ms) reached — shutting down (D-025 backstop)`);
      try {
        opts.onSafetyNet?.();
      } catch {}
      drainUpgradeSockets();
      for (const server of httpServers) {
        try {
          server.close();
        } catch {}
      }
      release();
    }, safetyNetMs);
  };

  const nudgeSafetyNet = (): void => {
    if (safetyNetCancelled || safetyNetMs <= 0) return;
    armSafetyNet();
  };

  apiConfigNudge = nudgeSafetyNet;

  armSafetyNet();

  return {
    httpServers,
    port: realPort,
    release,
    detachSafetyNet,
    nudgeSafetyNet,
    drainUpgradeSockets,
  };
}

function notFoundStatic(res: ServerResponse): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 404;
  res.end();
}

interface ResolvedRequestedPort {
  port: number;
  fallbackToKernel: boolean;
}

function resolveRequestedPort(
  optsPort: string | undefined,
  envPort: string | undefined,
): ResolvedRequestedPort {
  if (optsPort !== undefined) {
    const parsed = Number.parseInt(optsPort, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 65535) {
      throw new Error(`Invalid --port value '${optsPort}'`);
    }
    return { port: parsed, fallbackToKernel: false };
  }
  if (envPort !== undefined && envPort !== '') {
    const parsed = Number.parseInt(envPort, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 65535) {
      throw new Error(`Invalid PORT env value '${envPort}'`);
    }
    return { port: parsed, fallbackToKernel: false };
  }
  return { port: DEFAULT_UI_PORT, fallbackToKernel: true };
}

type UiCollisionResult =
  | { mode: 'already-running'; port: number }
  | { mode: 'proxy'; handle: ProxyServerHandle; upstreamPort: number };

interface ResolveUiLockCollisionOptions {
  requestedPort: number;
  host: string;
  lockDir: string;
  readLock?: () =>
    | import('@inkeep/open-knowledge-server').UiLockMetadata
    | null
    | Promise<import('@inkeep/open-knowledge-server').UiLockMetadata | null>;
  pollIntervalMs?: number;
  pollDeadlineMs?: number;
}

export async function resolveUiLockCollision(
  opts: ResolveUiLockCollisionOptions,
): Promise<UiCollisionResult> {
  const readLock =
    opts.readLock ??
    (async () => {
      const { readUiLock } = await import('@inkeep/open-knowledge-server');
      return readUiLock(opts.lockDir);
    });

  const initial = await readLock();
  if (!initial) {
    throw new Error(
      'UI lock collision reported but the lock disappeared before handling — retry acquiring.',
    );
  }

  if (initial.port === opts.requestedPort && initial.port > 0) {
    return { mode: 'already-running', port: initial.port };
  }

  let upstreamPort = initial.port;
  if (upstreamPort === 0) {
    const deadline = Date.now() + (opts.pollDeadlineMs ?? 2000);
    const intervalMs = opts.pollIntervalMs ?? 100;
    while (Date.now() < deadline) {
      await new Promise<void>((done) => {
        setTimeout(done, intervalMs);
      });
      const lock = await readLock();
      if (lock && lock.port > 0) {
        upstreamPort = lock.port;
        break;
      }
    }
    if (upstreamPort === 0) {
      throw new Error('UI did not bind within 2s; run `ok clean`');
    }
    if (upstreamPort === opts.requestedPort) {
      return { mode: 'already-running', port: upstreamPort };
    }
  }

  const handle = await startProxyServer({
    listenPort: opts.requestedPort,
    host: opts.host,
    upstreamHost: 'localhost',
    upstreamPort,
  });
  return { mode: 'proxy', handle, upstreamPort };
}

export function uiCommand(getConfig: () => Config): Command {
  return new Command('ui')
    .description('Serve the OpenKnowledge React editor UI')
    .option(
      '-p, --port <port>',
      `UI port (default: $PORT env or ${DEFAULT_UI_PORT}, kernel-allocated fallback if busy)`,
    )
    .option(
      '-H, --host <host>',
      'UI host. Default: two-socket loopback bind (`[::1]` + `127.0.0.1`) so cross-family collisions fail loud. Pass an explicit host (e.g. `127.0.0.1`, `0.0.0.0`) to bind a single socket on that host.',
    )
    .action(async (opts: { port?: string; host?: string }) => {
      const { dim } = await import('../ui/colors.ts');
      const { UiLockCollisionError } = await import('@inkeep/open-knowledge-server');
      const { resolveLockDir } = await import('@inkeep/open-knowledge-server');
      const config = getConfig();
      const host = opts.host;

      let resolved: ResolvedRequestedPort;
      try {
        resolved = resolveRequestedPort(opts.port, process.env.PORT);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      const requestedPort = resolved.port;

      try {
        const handle = await startUiServer({
          config,
          cwd: process.cwd(),
          port: requestedPort,
          fallbackToKernel: resolved.fallbackToKernel,
          host,
        });
        const displayHost =
          host === undefined || host === '::' || host === '0.0.0.0' ? 'localhost' : host;
        console.log(`${dim('[ui]')} listening on http://${displayHost}:${handle.port}`);

        let shuttingDown = false;
        const shutdown = (signal: NodeJS.Signals) => {
          if (shuttingDown) return;
          shuttingDown = true;
          console.log(dim(`\n[ui] Shutting down (${signal})`));
          handle.detachSafetyNet();
          const finish = () => {
            try {
              handle.release();
            } finally {
              process.exit(process.exitCode ?? 0);
            }
          };
          handle.drainUpgradeSockets();
          closeHttpServers(handle.httpServers).then(finish, finish);
          setTimeout(finish, 2000).unref();
        };
        process.once('SIGINT', () => shutdown('SIGINT'));
        process.once('SIGTERM', () => shutdown('SIGTERM'));
        return;
      } catch (err) {
        if (!(err instanceof UiLockCollisionError)) throw err;

        const lockDir = resolveLockDir(process.cwd());
        const proxyHost = host ?? 'localhost';
        let result: UiCollisionResult;
        try {
          result = await resolveUiLockCollision({
            requestedPort,
            host: proxyHost,
            lockDir,
          });
        } catch (collisionErr) {
          console.error(
            collisionErr instanceof Error ? collisionErr.message : String(collisionErr),
          );
          process.exit(1);
        }

        if (result.mode === 'already-running') {
          console.log(`UI already running at http://${proxyHost}:${result.port}`);
          if (isNonInteractiveContext(process)) {
            const idleResolve = new Promise<void>((resolve) => {
              const shutdown = (signal: NodeJS.Signals): void => {
                console.log(dim(`\n[ui-keepalive] Shutting down (${signal})`));
                resolve();
              };
              process.once('SIGINT', () => shutdown('SIGINT'));
              process.once('SIGTERM', () => shutdown('SIGTERM'));
            });
            await idleResolve;
            return;
          }
          process.exit(0);
        }

        console.log(
          `UI running at http://${proxyHost}:${result.upstreamPort}; acting as HTTP proxy on port ${result.handle.port}`,
        );

        let shuttingDown = false;
        const shutdown = (signal: NodeJS.Signals) => {
          if (shuttingDown) return;
          shuttingDown = true;
          console.log(dim(`\n[ui-proxy] Shutting down (${signal})`));
          result.handle.close().finally(() => process.exit(process.exitCode ?? 0));
          setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
        };
        process.once('SIGINT', () => shutdown('SIGINT'));
        process.once('SIGTERM', () => shutdown('SIGTERM'));
      }
    });
}

export { resolveRequestedPort };

export function isNonInteractiveContext(proc: Pick<NodeJS.Process, 'stdout' | 'env'>): boolean {
  const hasTty = proc.stdout.isTTY === true;
  const hasPortEnv = typeof proc.env.PORT === 'string' && proc.env.PORT !== '';
  return !hasTty || hasPortEnv;
}
