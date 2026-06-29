import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  ASSET_EXTENSIONS,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
} from '@inkeep/open-knowledge-core';
import {
  createAssetServeMiddleware,
  createServer,
  getLogger,
  handleCollabSocketError,
  parseKeepaliveConnectionId,
  releaseServerLock,
  toBroadcasterKey,
  updateServerLockPort,
} from '@inkeep/open-knowledge-server';
import sirv from 'sirv';
import type { Plugin } from 'vite';
import { WebSocketServer } from 'ws';
import { parse as parseYaml } from 'yaml';
import { computeDevApiConfigResponse } from './api-config-handler.ts';

let configureServerInvocations = 0;

const PLUGIN_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = resolve(PLUGIN_DIR, '../../../..');

interface ContentConfig {
  dir: string;
}

export function resolveContentConfig(projectRoot: string): ContentConfig {
  const defaults: ContentConfig = { dir: projectRoot };
  const configPath = resolve(projectRoot, '.ok/config.yml');
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = parseYaml(raw) as Record<string, unknown> | null;
      const content = parsed?.content as Record<string, unknown> | undefined;
      if (typeof content?.dir === 'string') {
        defaults.dir = resolve(projectRoot, content.dir);
      }
    } catch (err) {
      console.warn('[hocuspocus] Failed to parse config:', err);
    }
  }
  return defaults;
}

const contentConfig = resolveContentConfig(PROJECT_ROOT);
const CONTENT_DIR = process.env.OK_TEST_CONTENT_DIR
  ? realpathSync(process.env.OK_TEST_CONTENT_DIR)
  : contentConfig.dir;
const CONTENT_ROOT = relative(PROJECT_ROOT, CONTENT_DIR);

mkdirSync(CONTENT_DIR, { recursive: true });

const isTestIsolated = Boolean(process.env.OK_TEST_CONTENT_DIR);
const gitEnabledForTest = isTestIsolated && process.env.OK_TEST_GIT_ENABLED === '1';

const SINGLE_DOC_REL_PATH = process.env.OK_TEST_SINGLE_DOC_REL_PATH || undefined;
const isEphemeralTest = isTestIsolated && SINGLE_DOC_REL_PATH !== undefined;
const TEST_PROJECT_DIR = process.env.OK_TEST_PROJECT_DIR
  ? realpathSync(process.env.OK_TEST_PROJECT_DIR)
  : undefined;

const KEEPALIVE_GRACE_MS = 10_000;
const MAX_COLLAB_MESSAGE_BYTES = 1024 * 1024;

let exitHandlerRegistered = false;
let latestLockDir: string | null = null;

export function hocuspocusPlugin(): Plugin {
  return {
    name: 'hocuspocus',
    async configureServer(server) {
      const keepaliveGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
      const keepaliveGraceInflight = new Set<Promise<void>>();
      let shuttingDown = false;

      configureServerInvocations += 1;
      if (configureServerInvocations > 1) {
        console.warn(
          `[collab] configureServer invoked ${configureServerInvocations}× — Vite restarted; spinning up a fresh ServerInstance. The previous srv will be destroyed by its httpServer close handler.`,
        );
      } else {
        console.info(`[collab] configureServer invocation=1 pid=${process.pid}`);
      }

      const currentSrv = createServer({
        contentDir: CONTENT_DIR,
        projectDir: TEST_PROJECT_DIR ?? (isTestIsolated ? CONTENT_DIR : PROJECT_ROOT),
        contentRoot: isTestIsolated ? '' : CONTENT_ROOT,
        gitEnabled: isEphemeralTest ? false : !isTestIsolated || gitEnabledForTest,
        enableTestRoutes: true,
        quiet: true,
        ...(isEphemeralTest ? { ephemeral: true, singleDocRelPath: SINGLE_DOC_REL_PATH } : {}),
      });

      latestLockDir = currentSrv.lockDir;
      if (!exitHandlerRegistered) {
        exitHandlerRegistered = true;
        process.once('exit', () => {
          if (latestLockDir === null) return;
          try {
            releaseServerLock(latestLockDir);
          } catch {}
        });
      }

      if (configureServerInvocations === 1) {
        getLogger('hocuspocus').info({ contentDir: CONTENT_DIR }, 'content dir');
      }

      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address();
        if (typeof addr === 'object' && addr !== null) {
          updateServerLockPort(currentSrv.lockDir, addr.port);
        }
      });

      const { hocuspocus, sessionManager, agentFocusBroadcaster, agentPresenceBroadcaster } =
        currentSrv;

      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_COLLAB_MESSAGE_BYTES });
      wss.on('error', (err) => {
        console.error('[collab] WebSocketServer error:', err);
      });

      server.httpServer?.prependListener('upgrade', (req, socket, head) => {
        if (!req.url?.startsWith('/collab')) return;

        console.info(
          `[collab] upgrade received url=${req.url} protocol=${req.headers['sec-websocket-protocol'] ?? 'none'} host=${req.headers.host ?? 'none'} origin=${req.headers.origin ?? 'none'}`,
        );

        if (req.url.startsWith('/collab/keepalive')) {
          socket.on('error', (err: NodeJS.ErrnoException) => {
            if (handleCollabSocketError(err)) return;
            console.error('[collab] MCP keepalive socket error:', err);
          });
          console.info(`[collab] keepalive handleUpgrade starting for ${req.url}`);
          try {
            wss.handleUpgrade(req, socket, head, (ws) => {
              const connectionId = parseKeepaliveConnectionId(req.url);

              if (connectionId) {
                const existing = keepaliveGraceTimers.get(connectionId);
                if (existing !== undefined) {
                  clearTimeout(existing);
                  keepaliveGraceTimers.delete(connectionId);
                  console.info(
                    `[keepalive] reconnect during grace — timer cancelled connectionId=${connectionId}`,
                  );
                }
              }

              console.info(`[collab] keepalive handshake complete for ${req.url}`);

              const pingTimer = setInterval(() => {
                try {
                  ws.ping();
                } catch {}
              }, 30_000);
              pingTimer.unref?.();

              const tsRefreshTimer = connectionId
                ? setInterval(() => {
                    agentPresenceBroadcaster?.bumpPresenceTs(toBroadcasterKey(connectionId));
                  }, 3_000)
                : null;
              tsRefreshTimer?.unref?.();

              ws.on('close', () => {
                clearInterval(pingTimer);
                if (tsRefreshTimer !== null) clearInterval(tsRefreshTimer);
                if (!connectionId) return;
                const timer = setTimeout(() => {
                  keepaliveGraceTimers.delete(connectionId);
                  if (shuttingDown) return;
                  const work = (async () => {
                    console.info(
                      `[keepalive] grace expired — cleaning up sessions connectionId=${connectionId}`,
                    );
                    try {
                      await sessionManager.closeAllForAgent(connectionId);
                    } catch (err) {
                      console.error(
                        `[keepalive] closeAllForAgent failed connectionId=${connectionId}`,
                        err,
                      );
                    }
                    try {
                      agentFocusBroadcaster?.clearFocus(connectionId);
                    } catch (err) {
                      console.error(
                        `[keepalive] clearFocus failed connectionId=${connectionId}`,
                        err,
                      );
                    }
                    try {
                      agentPresenceBroadcaster?.clearPresence(toBroadcasterKey(connectionId));
                    } catch (err) {
                      console.error(
                        `[keepalive] clearPresence failed connectionId=${connectionId}`,
                        err,
                      );
                    }
                  })();
                  keepaliveGraceInflight.add(work);
                  work.finally(() => keepaliveGraceInflight.delete(work));
                }, KEEPALIVE_GRACE_MS);
                timer.unref?.();
                keepaliveGraceTimers.set(connectionId, timer);
                console.info(
                  `[keepalive] disconnected — grace timer started connectionId=${connectionId} graceMs=${KEEPALIVE_GRACE_MS}`,
                );
              });
              ws.on('error', (err: NodeJS.ErrnoException) => {
                if (!handleCollabSocketError(err)) {
                  console.error('[collab] keepalive WS error:', err);
                }
                ws.terminate();
              });
            });
          } catch (err) {
            console.error(`[collab] keepalive handleUpgrade threw for ${req.url}:`, err);
            try {
              socket.destroy();
            } catch {}
          }
          return;
        }

        socket.on('error', (err: NodeJS.ErrnoException) => {
          if (handleCollabSocketError(err)) return;
          console.error('[collab] Upgrade socket error:', err);
        });

        console.info(`[collab] handleUpgrade starting for ${req.url}`);

        try {
          wss.handleUpgrade(req, socket, head, (ws) => {
            const beforeCount = hocuspocus.getConnectionsCount?.() ?? -1;
            console.info(
              `[collab] handshake complete for ${req.url} (connections before=${beforeCount})`,
            );
            const clientConnection = hocuspocus.handleConnection(ws, req);
            let closedByPolicy = false;
            ws.on('message', (data: ArrayBuffer | Buffer) => {
              if (closedByPolicy) return;
              if (data.byteLength > MAX_COLLAB_MESSAGE_BYTES) {
                closedByPolicy = true;
                console.warn(
                  `[collab] frame rejected: ${data.byteLength} bytes exceeds ${MAX_COLLAB_MESSAGE_BYTES} byte limit`,
                );
                ws.close(1009, 'Message Too Big');
                return;
              }
              clientConnection.handleMessage(new Uint8Array(data as Buffer));
            });
            ws.on('close', (code: number, reason: Buffer) => {
              clientConnection.handleClose({ code, reason: reason.toString() });
            });
            ws.on('error', (err: NodeJS.ErrnoException) => {
              if (!handleCollabSocketError(err)) {
                console.error('[collab] WebSocket error:', err);
              }
              ws.terminate();
            });
          });
        } catch (err) {
          console.error(`[collab] handleUpgrade threw for ${req.url}:`, err);
          try {
            socket.destroy();
          } catch {}
        }
      });

      const assetMiddleware = createAssetServeMiddleware({
        contentFilter: currentSrv.contentFilter,
        contentSirv: sirv(CONTENT_DIR, { dev: true, dotfiles: false }),
        inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
        assetExtensions: ASSET_EXTENSIONS,
        blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
      });
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        const path = url.split('?')[0] ?? '';
        const queryStart = url.indexOf('?');
        const query = queryStart >= 0 ? url.slice(queryStart) : '';
        const params = query ? new URLSearchParams(query) : null;
        if (
          path.startsWith('/@vite/') ||
          path.startsWith('/@fs/') ||
          path.startsWith('/@id/') ||
          path === '/@react-refresh' ||
          path.startsWith('/node_modules/') ||
          path.startsWith('/src/') ||
          path === '/favicon.svg' ||
          params?.has('import') ||
          params?.has('html-proxy')
        ) {
          return next();
        }
        return assetMiddleware(req, res, next);
      });

      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];
        if (url?.startsWith('/api/')) {
          if (url === '/api/config') {
            const addr = server.httpServer?.address();
            const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
            const response = computeDevApiConfigResponse(req.method, port, isEphemeralTest);
            if (response) {
              for (const [name, value] of Object.entries(response.headers)) {
                res.setHeader(name, value);
              }
              res.statusCode = response.status;
              if (response.omitBody) {
                res.end();
              } else {
                res.end(response.body);
              }
              return;
            }
          }
          // biome-ignore lint/suspicious/noExplicitAny: Hocuspocus `hooks()` has no exported payload type for onRequest
          await hocuspocus.hooks('onRequest', { request: req, response: res } as any);
          if (res.writableEnded || res.headersSent) return;
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'API route not found', path: url }));
          return;
        }
        next();
      });

      server.httpServer?.on('close', async () => {
        shuttingDown = true;
        for (const timer of keepaliveGraceTimers.values()) {
          clearTimeout(timer);
        }
        keepaliveGraceTimers.clear();
        if (keepaliveGraceInflight.size > 0) {
          await Promise.allSettled(keepaliveGraceInflight);
        }
        try {
          await currentSrv.destroy();
        } catch (err) {
          console.error('[hocuspocus] srv.destroy() failed:', err);
        }
      });

      getLogger('hocuspocus').info({}, 'WebSocket server ready on /collab');
    },
  };
}
